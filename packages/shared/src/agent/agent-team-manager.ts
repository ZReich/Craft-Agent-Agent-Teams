/**
 * Agent Team Manager
 *
 * Central service for managing agent teams — lifecycle, teammates, tasks, messaging.
 * For Claude teammates, the lead agent spawns them via native SDK team tools.
 * For non-Claude workers (Kimi, OpenRouter), the manager spawns them directly
 * via the provider abstraction and connects them to the shared task list and mailbox.
 */

import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type {
  AgentTeam,
  AgentTeammate,
  AgentTeammateStatus,
  TeamTask,
  TeamTaskStatus,
  TeammateMessage,
  TeamModelConfig,
  ModelPresetId,
  TeamActivityEvent,
  TeamActivityType,
  TeamCostSummary,
  TeammateTokenUsage,
  Spec,
  DRIAssignment,
  YoloState,
  TeamPhase,
  QualityGateResult,
} from '@craft-agent/core/types';
import type { ReviewLoopOrchestrator } from '../agent-teams/review-loop';
import type { YoloOrchestrator } from '../agent-teams/yolo-orchestrator';
import { TeamStateStore } from '../agent-teams/team-state-store';
import type { TeamState } from '../agent-teams/team-state-store';

// ============================================================
// Types
// ============================================================

export interface CreateTeamOptions {
  name: string;
  leadSessionId: string;
  modelConfig: TeamModelConfig;
  modelPreset?: ModelPresetId;
  workspaceRootPath: string;
}

export interface SpawnTeammateOptions {
  teamId: string;
  name: string;
  role: string;
  model: string;
  provider: string;
}

export interface TeamManagerEvents {
  'team:created': (team: AgentTeam) => void;
  'team:updated': (team: AgentTeam) => void;
  'team:cleanup': (teamId: string) => void;
  'teammate:spawned': (teammate: AgentTeammate) => void;
  'teammate:updated': (teammate: AgentTeammate) => void;
  'teammate:shutdown': (teammateId: string) => void;
  'task:created': (task: TeamTask) => void;
  'task:updated': (task: TeamTask) => void;
  'message:sent': (message: TeammateMessage) => void;
  'activity': (event: TeamActivityEvent) => void;
  'cost:updated': (teamId: string, cost: TeamCostSummary) => void;
  'yolo:state_changed': (teamId: string, state: import('@craft-agent/core/types').YoloState) => void;
  'synthesis:requested': (payload: {
    teamId: string;
    completedTasks: TeamTask[];
    requirementCoverage: number;
    outstandingItems: string[];
  }) => void;
}

// ============================================================
// Manager Implementation
// ============================================================

export class AgentTeamManager extends EventEmitter {
  private static readonly MAX_ACTIVITY_EVENTS = 1500;
  private static readonly MAX_TEAM_MESSAGES = 2000;
  private static readonly MAX_TEAM_TASKS = 3000;

  private teams = new Map<string, AgentTeam>();
  private tasks = new Map<string, TeamTask[]>();  // teamId → tasks
  private messages = new Map<string, TeammateMessage[]>();  // teamId → messages
  private activityLog = new Map<string, TeamActivityEvent[]>();  // teamId → activity events
  private teamSpecs = new Map<string, Spec>();  // teamId → active spec
  private teamDRIAssignments = new Map<string, DRIAssignment[]>();  // teamId → DRI assignments
  private synthesisRequested = new Set<string>();  // teamIds that already emitted synthesis request
  private yoloStates = new Map<string, YoloState>();  // teamId → YOLO state
  private teamPhases = new Map<string, TeamPhase[]>();  // teamId → phases
  private yoloOrchestrators = new Map<string, YoloOrchestrator>();  // teamId → orchestrator
  // Implements REQ-002: persist team state across close/reopen
  private teamStateStores = new Map<string, TeamStateStore>();  // teamId → state store
  // Implements BUG-7: store quality gate results per teammate
  private qualityGateResults = new Map<string, Map<string, QualityGateResult>>();  // teamId → (teammateSessionId → result)

  /** Review loop orchestrator — when set, task completions are routed through quality gates */
  private reviewLoop: ReviewLoopOrchestrator | null = null;

  /**
   * Attach a review loop orchestrator.
   * When attached, task completions from teammates are intercepted and routed
   * through quality gate review before being accepted as truly "completed."
   */
  setReviewLoop(reviewLoop: ReviewLoopOrchestrator | null): void {
    this.reviewLoop = reviewLoop;
  }

  /** Get the attached review loop (if any) */
  getReviewLoop(): ReviewLoopOrchestrator | null {
    return this.reviewLoop;
  }

  // ── Team State Persistence ──────────────────────────────────

  /**
   * Initialize a TeamStateStore for a team. Called when creating a team
   * or when resuming a team session from a known session path.
   * Implements REQ-002: persist team state across close/reopen.
   */
  initStateStore(teamId: string, sessionDirPath: string): void {
    if (!this.teamStateStores.has(teamId)) {
      this.teamStateStores.set(teamId, new TeamStateStore(sessionDirPath));
    }
  }

  /**
   * Load persisted team state from disk.
   * Returns messages, tasks, and activity that were saved before the app closed.
   */
  loadPersistedState(teamId: string): TeamState | null {
    const store = this.teamStateStores.get(teamId);
    if (!store) return null;
    try {
      return store.load();
    } catch {
      return null;
    }
  }

  /**
   * Load persisted state from a session path (without requiring the store
   * to be initialized first). Used by IPC handlers when the team manager
   * may not have the store initialized yet.
   */
  loadPersistedStateFromPath(sessionDirPath: string): TeamState {
    const store = new TeamStateStore(sessionDirPath);
    return store.load();
  }

  private pushCapped<T>(arr: T[], item: T, max: number): void {
    arr.push(item);
    if (arr.length > max) {
      arr.splice(0, arr.length - max);
    }
  }

  private trimTasks(tasks: TeamTask[]): TeamTask[] {
    if (tasks.length <= AgentTeamManager.MAX_TEAM_TASKS) {
      return tasks;
    }

    const openTasks = tasks.filter(t => t.status !== 'completed');
    const completedTasks = tasks.filter(t => t.status === 'completed');

    const completedSlots = Math.max(0, AgentTeamManager.MAX_TEAM_TASKS - openTasks.length);
    const keptCompleted = completedSlots > 0
      ? completedTasks.slice(-completedSlots)
      : [];

    return [...openTasks, ...keptCompleted];
  }

  // ============================================================
  // Team Lifecycle
  // ============================================================

  /** Create a new agent team */
  createTeam(options: CreateTeamOptions): AgentTeam {
    const team: AgentTeam = {
      id: `team-${randomUUID().slice(0, 8)}`,
      name: options.name,
      leadSessionId: options.leadSessionId,
      status: 'active',
      createdAt: new Date().toISOString(),
      members: [],
      modelPreset: options.modelPreset,
    };

    this.teams.set(team.id, team);
    this.tasks.set(team.id, []);
    this.messages.set(team.id, []);
    this.activityLog.set(team.id, []);
    this.teamDRIAssignments.set(team.id, []);

    // Initialize state store for persistence (REQ-002)
    if (options.workspaceRootPath) {
      const { join: joinPath } = require('path');
      const sessionsDir = joinPath(options.workspaceRootPath, 'sessions', options.leadSessionId);
      this.initStateStore(team.id, sessionsDir);
    }

    this.emit('team:created', team);
    this.addActivity(team.id, 'teammate-spawned', 'Team created', undefined, undefined);

    return team;
  }

  /** Clean up a team — shut down all teammates and mark as completed */
  async cleanupTeam(teamId: string): Promise<void> {
    const team = this.teams.get(teamId);
    if (!team) return;

    team.status = 'cleaning-up';
    this.emit('team:updated', team);

    // Shut down all non-lead teammates
    for (const member of team.members) {
      if (!member.isLead && member.status !== 'shutdown') {
        member.status = 'shutdown';
        this.emit('teammate:updated', member);
        this.emit('teammate:shutdown', member.id);
      }
    }

    team.status = 'completed';
    team.members = [];
    this.emit('team:updated', team);
    this.emit('team:cleanup', teamId);
    this.addActivity(teamId, 'teammate-shutdown', 'Team cleaned up', undefined, undefined);

    // Clean up review loop state for this team
    this.reviewLoop?.cleanup(teamId);

    // Stop YOLO if running
    this.stopYolo(teamId, 'Team cleanup');

    // Release hot runtime memory immediately after cleanup.
    this.tasks.delete(teamId);
    this.messages.delete(teamId);
    this.activityLog.delete(teamId);
    this.teamSpecs.delete(teamId);
    this.teamDRIAssignments.delete(teamId);
    this.synthesisRequested.delete(teamId);
    this.yoloStates.delete(teamId);
    this.yoloOrchestrators.delete(teamId);
    this.teamPhases.delete(teamId);
    this.teams.delete(teamId);
  }

  /** Get team status */
  getTeam(teamId: string): AgentTeam | undefined {
    return this.teams.get(teamId);
  }

  /** Find a team by name */
  getTeamByName(name: string): AgentTeam | undefined {
    return Array.from(this.teams.values()).find(team => team.name === name);
  }

  /** Resolve team identifier (id or name) to a known team id */
  resolveTeamId(teamIdOrName: string): string {
    if (this.teams.has(teamIdOrName)) return teamIdOrName;
    const byName = this.getTeamByName(teamIdOrName);
    return byName?.id ?? teamIdOrName;
  }

  /** Get all active teams */
  getActiveTeams(): AgentTeam[] {
    return Array.from(this.teams.values()).filter(t => t.status === 'active');
  }

  /** Set active spec for a team (SDD integration) */
  setTeamSpec(teamId: string, spec?: Spec): void {
    if (!spec) {
      this.teamSpecs.delete(teamId);
      return;
    }
    this.teamSpecs.set(teamId, spec);
  }

  /** Get active spec for a team (SDD integration) */
  getTeamSpec(teamId: string): Spec | undefined {
    return this.teamSpecs.get(teamId);
  }

  /** Set DRI assignments for a team */
  setTeamDRIAssignments(teamId: string, assignments: DRIAssignment[]): void {
    this.teamDRIAssignments.set(teamId, assignments);
  }

  // Implements BUG-1: Toggle delegate mode for a team
  toggleDelegateMode(teamId: string): boolean {
    const team = this.teams.get(teamId);
    if (!team) return false;
    team.delegateMode = !team.delegateMode;
    this.emit('team:updated', team);
    this.addActivity(
      teamId,
      team.delegateMode ? 'teammate-spawned' : 'teammate-shutdown',
      `Delegate mode ${team.delegateMode ? 'enabled' : 'disabled'} — lead is ${team.delegateMode ? 'coordination-only' : 'fully active'}`,
    );
    return team.delegateMode;
  }

  // Implements BUG-7: Store quality gate result for a teammate
  storeQualityResult(teamId: string, teammateSessionId: string, result: QualityGateResult): void {
    if (!this.qualityGateResults.has(teamId)) {
      this.qualityGateResults.set(teamId, new Map());
    }
    this.qualityGateResults.get(teamId)!.set(teammateSessionId, result);
  }

  // Implements BUG-7: Get quality gate results for all teammates in a team
  getQualityReports(teamId: string): Record<string, QualityGateResult> {
    const results = this.qualityGateResults.get(teamId);
    if (!results) return {};
    const out: Record<string, QualityGateResult> = {};
    for (const [sessionId, result] of results) {
      out[sessionId] = result;
    }
    return out;
  }

  // ============================================================
  // Teammate Management
  // ============================================================

  /** Spawn a new teammate */
  spawnTeammate(options: SpawnTeammateOptions): AgentTeammate {
    const team = this.teams.get(options.teamId);
    if (!team) throw new Error(`Team not found: ${options.teamId}`);

    const teammate: AgentTeammate = {
      id: `mate-${randomUUID().slice(0, 8)}`,
      name: options.name,
      role: options.role,
      agentId: '', // Set after SDK/worker spawns
      sessionId: '', // Set after session creation
      status: 'spawning',
      model: options.model,
      provider: options.provider,
      tokenUsage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };

    team.members.push(teammate);
    this.emit('teammate:spawned', teammate);
    this.emit('team:updated', team);
    this.addActivity(
      options.teamId,
      'teammate-spawned',
      `${teammate.name} joined the team (${teammate.model})`,
      teammate.id,
      teammate.name
    );

    return teammate;
  }

  /** Update teammate status */
  updateTeammateStatus(teamId: string, teammateId: string, status: AgentTeammateStatus, currentTask?: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;

    const teammate = team.members.find(m => m.id === teammateId);
    if (!teammate) return;

    teammate.status = status;
    if (currentTask !== undefined) teammate.currentTask = currentTask;

    this.emit('teammate:updated', teammate);
    this.emit('team:updated', team);
  }

  /** Shut down a specific teammate */
  shutdownTeammate(teamId: string, teammateId: string): void {
    const team = this.teams.get(teamId);
    if (!team) return;

    const teammate = team.members.find(m => m.id === teammateId);
    if (!teammate) return;

    teammate.status = 'shutdown';
    this.emit('teammate:updated', teammate);
    this.emit('teammate:shutdown', teammateId);
    this.emit('team:updated', team);
    this.addActivity(
      teamId,
      'teammate-shutdown',
      `${teammate.name} shut down`,
      teammate.id,
      teammate.name
    );
  }

  /** Update teammate token usage */
  updateTeammateUsage(teamId: string, teammateId: string, usage: Partial<TeammateTokenUsage>): void {
    const team = this.teams.get(teamId);
    if (!team) return;

    const teammate = team.members.find(m => m.id === teammateId);
    if (!teammate || !teammate.tokenUsage) return;

    if (usage.inputTokens !== undefined) teammate.tokenUsage.inputTokens += usage.inputTokens;
    if (usage.outputTokens !== undefined) teammate.tokenUsage.outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) teammate.tokenUsage.costUsd += usage.costUsd;

    this.emit('cost:updated', teamId, this.getCostSummary(teamId));
  }

  // ============================================================
  // Task Coordination
  // ============================================================

  /** Create a new task */
  createTask(
    teamId: string,
    title: string,
    description?: string,
    createdBy?: string,
    options?: {
      requirementIds?: string[];
      driOwner?: string;
      driReviewer?: string;
      ticketLinks?: TeamTask['ticketLinks'];
      assignee?: string;
      dependencies?: string[];
      taskType?: TeamTask['taskType'];
    }
  ): TeamTask {
    const task: TeamTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title,
      description,
      status: 'pending',
      taskType: options?.taskType,
      requirementIds: options?.requirementIds,
      driOwner: options?.driOwner,
      driReviewer: options?.driReviewer,
      ticketLinks: options?.ticketLinks,
      assignee: options?.assignee,
      dependencies: options?.dependencies,
      createdAt: new Date().toISOString(),
      createdBy,
    };

    const teamTasks = this.tasks.get(teamId) || [];
    this.pushCapped(teamTasks, task, AgentTeamManager.MAX_TEAM_TASKS + 100);
    this.tasks.set(teamId, this.trimTasks(teamTasks));

    // Persist to disk (REQ-002)
    this.teamStateStores.get(teamId)?.appendTask(task);

    this.emit('task:created', task);
    return task;
  }

  /**
   * Update task status.
   *
   * When a review loop is attached and a task is marked 'completed' by a teammate,
   * the task is intercepted and routed to quality gate review ('in_review') instead.
   * The review loop will call back to set the final 'completed' status after passing.
   *
   * @param options.bypassReviewLoop - Set to true to skip review loop interception
   *   (used internally by the review loop itself when a task passes quality gates)
   */
  updateTaskStatus(
    teamId: string,
    taskId: string,
    status: TeamTaskStatus,
    assignee?: string,
    options?: { bypassReviewLoop?: boolean },
  ): void {
    const teamTasks = this.tasks.get(teamId) || [];
    const task = teamTasks.find(t => t.id === taskId);
    if (!task) return;

    // --- Review Loop Interception ---
    // When a teammate marks a task "completed" and a review loop is attached,
    // route through quality gates instead of accepting immediately.
    if (
      status === 'completed' &&
      this.reviewLoop &&
      !options?.bypassReviewLoop &&
      task.assignee // only intercept teammate tasks (not lead/system tasks)
    ) {
      task.status = 'in_review';
      this.emit('task:updated', task);
      this.tasks.set(teamId, this.trimTasks(teamTasks));
      this.addActivity(teamId, 'task-in-review', `Task "${task.title}" → quality gate review`, undefined, undefined, taskId);
      this.reviewLoop.enqueueReview(teamId, taskId, task);
      return;
    }

    task.status = status;
    if (assignee !== undefined) task.assignee = assignee;
    if (status === 'completed') task.completedAt = new Date().toISOString();

    // Persist updated task to disk (REQ-002)
    this.teamStateStores.get(teamId)?.appendTask(task);

    this.emit('task:updated', task);
    this.tasks.set(teamId, this.trimTasks(teamTasks));

    // Add activity
    const activityType: TeamActivityType = status === 'completed' ? 'task-completed'
      : status === 'in_progress' ? 'task-claimed'
      : status === 'in_review' ? 'task-in-review'
      : status === 'failed' ? 'task-failed'
      : 'task-claimed';
    this.addActivity(teamId, activityType, `Task "${task.title}" → ${status}`, undefined, undefined, taskId);

    // Trigger synthesis prompt once when all teammate tasks are completed
    if (status === 'completed') {
      const allTeammateTasksComplete = teamTasks
        .filter(t => t.assignee) // teammate tasks are assigned
        .every(t => t.status === 'completed');
      if (allTeammateTasksComplete) {
        this.autoSynthesize(teamId);
      }
    }
  }

  /** Get task list for a team */
  getTasks(teamId: string): TeamTask[] {
    return this.tasks.get(teamId) || [];
  }

  /** Assign a task to a teammate */
  assignTask(teamId: string, taskId: string, teammateId: string): void {
    this.updateTaskStatus(teamId, taskId, 'in_progress', teammateId);
  }

  // ============================================================
  // Messaging
  // ============================================================

  /** Send a message from one teammate to another */
  sendMessage(teamId: string, from: string, to: string, content: string): TeammateMessage {
    const msg: TeammateMessage = {
      id: `msg-${randomUUID().slice(0, 8)}`,
      from,
      to,
      content,
      timestamp: new Date().toISOString(),
      type: 'message',
    };

    const teamMessages = this.messages.get(teamId) || [];
    this.pushCapped(teamMessages, msg, AgentTeamManager.MAX_TEAM_MESSAGES);
    this.messages.set(teamId, teamMessages);

    // Persist to disk (REQ-002)
    this.teamStateStores.get(teamId)?.appendMessage(msg);

    this.emit('message:sent', msg);
    this.addActivity(teamId, 'message-sent', `Message from ${from} to ${to}`, from, undefined);
    return msg;
  }

  /** Broadcast a message to all teammates */
  broadcastMessage(teamId: string, from: string, content: string): TeammateMessage {
    return this.sendMessage(teamId, from, 'all', content);
  }

  /** Get messages for a team */
  getMessages(teamId: string): TeammateMessage[] {
    return this.messages.get(teamId) || [];
  }

  // ============================================================
  // Activity Feed
  // ============================================================

  private addActivity(
    teamId: string,
    type: TeamActivityType,
    details: string,
    teammateId?: string,
    teammateName?: string,
    taskId?: string
  ): void {
    const event: TeamActivityEvent = {
      id: `act-${randomUUID().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      type,
      teamId,
      details,
      teammateId,
      teammateName,
      taskId,
    };

    const log = this.activityLog.get(teamId) || [];
    this.pushCapped(log, event, AgentTeamManager.MAX_ACTIVITY_EVENTS);
    this.activityLog.set(teamId, log);

    // Persist to disk (REQ-002)
    this.teamStateStores.get(teamId)?.appendActivity(event);

    this.emit('activity', event);
  }

  /** Public wrapper for emitting activity events (used by session manager) */
  logActivity(
    teamId: string,
    type: TeamActivityType,
    details: string,
    teammateId?: string,
    teammateName?: string,
    taskId?: string
  ): void {
    this.addActivity(teamId, type, details, teammateId, teammateName, taskId);
  }

  /** Get activity log for a team */
  getActivityLog(teamId: string): TeamActivityEvent[] {
    return this.activityLog.get(teamId) || [];
  }

  // ============================================================
  // Cost Tracking
  // ============================================================

  /** Get cost summary for a team */
  getCostSummary(teamId: string): TeamCostSummary {
    const team = this.teams.get(teamId);
    if (!team) {
      return {
        totalCostUsd: 0,
        perTeammate: {},
        perModel: {},
      };
    }

    const perTeammate: Record<string, TeammateTokenUsage> = {};
    const perModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }> = {};
    let totalCostUsd = 0;

    for (const member of team.members) {
      if (member.tokenUsage) {
        perTeammate[member.id] = { ...member.tokenUsage };
        totalCostUsd += member.tokenUsage.costUsd;

        const modelKey = member.model;
        if (!perModel[modelKey]) {
          perModel[modelKey] = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
        }
        perModel[modelKey].inputTokens += member.tokenUsage.inputTokens;
        perModel[modelKey].outputTokens += member.tokenUsage.outputTokens;
        perModel[modelKey].costUsd += member.tokenUsage.costUsd;
      }
    }

    return {
      totalCostUsd,
      perTeammate,
      perModel,
    };
  }

  /**
   * Validate DRI coverage for team spec requirements and sections.
   * Returns missing section/requirement ownership details.
   */
  validateDRICoverage(teamId: string): { valid: boolean; missing: string[] } {
    const missing: string[] = [];
    const spec = this.teamSpecs.get(teamId);
    const tasks = this.getTasks(teamId);
    const assignments = this.teamDRIAssignments.get(teamId) || [];

    if (!spec) {
      return { valid: true, missing };
    }

    const requiredSections = [
      'goals',
      'nonGoals',
      'requirements',
      'risks',
      'mitigations',
      'rolloutPlan',
      'rollbackPlan',
      'testPlan',
      'observabilityPlan',
    ];

    const assignedSections = new Set(assignments.flatMap(a => a.sections));
    for (const section of requiredSections) {
      if (!assignedSections.has(section)) {
        missing.push(`Missing DRI assignment for spec section: ${section}`);
      }
    }

    for (const req of spec.requirements) {
      const hasOwnerInSpec = !!req.assignedDRI;
      const hasOwnerInAssignments = assignments.some(a => a.sections.includes(req.id));
      const hasOwnerInTasks = tasks.some(t =>
        (t.requirementIds || []).includes(req.id) && !!t.driOwner
      );

      if (!hasOwnerInSpec && !hasOwnerInAssignments && !hasOwnerInTasks) {
        missing.push(`Missing owner for requirement: ${req.id}`);
      }
    }

    return { valid: missing.length === 0, missing };
  }

  /**
   * Check whether a team plan can be closed.
   * Requires DRI coverage and requirement coverage at 100%.
   */
  canClosePlan(teamId: string): { canClose: boolean; blockers: string[] } {
    const blockers: string[] = [];
    const spec = this.teamSpecs.get(teamId);
    const tasks = this.getTasks(teamId);

    const driValidation = this.validateDRICoverage(teamId);
    if (!driValidation.valid) {
      blockers.push(...driValidation.missing);
    }

    if (spec) {
      const uncoveredRequirements = spec.requirements
        .filter(req => !tasks.some(task => (task.requirementIds || []).includes(req.id)))
        .map(req => req.id);

      if (uncoveredRequirements.length > 0) {
        blockers.push(
          `Requirement coverage below 100% (missing tasks for: ${uncoveredRequirements.join(', ')})`
        );
      }
    }

    return {
      canClose: blockers.length === 0,
      blockers,
    };
  }

  // ============================================================
  // YOLO Mode (Autonomous Execution)
  // ============================================================

  /** Attach a YOLO orchestrator for a team */
  setYoloOrchestrator(teamId: string, orchestrator: YoloOrchestrator | null): void {
    if (!orchestrator) {
      this.yoloOrchestrators.delete(teamId);
      return;
    }
    this.yoloOrchestrators.set(teamId, orchestrator);

    // Forward YOLO state changes to team events
    orchestrator.on('yolo:phase-changed', (data: { teamId: string; phase: string }) => {
      const state = orchestrator.getState();
      if (state) {
        this.yoloStates.set(data.teamId, { ...state });
        this.emit('yolo:state_changed', data.teamId, state);
      }
    });
  }

  /** Get the YOLO orchestrator for a team */
  getYoloOrchestrator(teamId: string): YoloOrchestrator | undefined {
    return this.yoloOrchestrators.get(teamId);
  }

  /** Get YOLO state for a team */
  getYoloState(teamId: string): YoloState | undefined {
    return this.yoloStates.get(teamId);
  }

  /** Update YOLO state for a team (called by the orchestrator's onStateChange callback) */
  updateYoloState(teamId: string, state: YoloState): void {
    this.yoloStates.set(teamId, state);
    this.emit('yolo:state_changed', teamId, state);
  }

  /** Stop a YOLO run for a team */
  stopYolo(teamId: string, reason?: string): void {
    const orchestrator = this.yoloOrchestrators.get(teamId);
    if (orchestrator?.isRunning()) {
      orchestrator.abort(reason || 'Stopped by user');
    }
  }

  /** Check if a team is in YOLO mode */
  isYoloActive(teamId: string): boolean {
    const orchestrator = this.yoloOrchestrators.get(teamId);
    return orchestrator?.isRunning() ?? false;
  }

  // ============================================================
  // Phase Management
  // ============================================================

  /** Set phases for a team */
  setTeamPhases(teamId: string, phases: TeamPhase[]): void {
    this.teamPhases.set(teamId, phases);
  }

  /** Get phases for a team */
  getTeamPhases(teamId: string): TeamPhase[] {
    return this.teamPhases.get(teamId) || [];
  }

  /** Get the current active phase for a team */
  getCurrentPhase(teamId: string): TeamPhase | undefined {
    const phases = this.teamPhases.get(teamId) || [];
    return phases
      .sort((a, b) => a.order - b.order)
      .find(p => p.status === 'in-progress' || p.status === 'pending');
  }

  /** Check if all tasks in a phase are completed */
  isPhaseComplete(teamId: string, phaseId: string): boolean {
    const tasks = this.getTasks(teamId);
    const phaseTasks = tasks.filter(t => t.phase === phaseId);
    if (phaseTasks.length === 0) return true;
    return phaseTasks.every(t => t.status === 'completed');
  }

  /** Check if a task can start based on its phase ordering */
  canTaskStart(teamId: string, taskId: string): boolean {
    const tasks = this.getTasks(teamId);
    const task = tasks.find(t => t.id === taskId);
    if (!task || !task.phase || task.phaseOrder === undefined) return true;

    const phases = this.teamPhases.get(teamId) || [];
    const currentPhase = phases.find(p => p.id === task.phase);
    if (!currentPhase) return true;

    // Check that all earlier phases are completed
    const earlierPhases = phases.filter(p => p.order < currentPhase.order);
    for (const earlier of earlierPhases) {
      if (earlier.status !== 'completed') {
        return false;
      }
    }

    return true;
  }

  /**
   * Emit synthesis request for the lead when all teammate tasks are complete.
   */
  autoSynthesize(teamId: string): void {
    if (this.synthesisRequested.has(teamId)) return;

    const tasks = this.getTasks(teamId);
    const completedTasks = tasks.filter(t => t.status === 'completed');
    const outstanding = tasks.filter(t => t.status !== 'completed');

    const spec = this.teamSpecs.get(teamId);
    let requirementCoverage = 100;
    if (spec && spec.requirements.length > 0) {
      const covered = spec.requirements.filter(req =>
        tasks.some(task => (task.requirementIds || []).includes(req.id))
      ).length;
      requirementCoverage = Math.round((covered / spec.requirements.length) * 100);
    }

    const payload = {
      teamId,
      completedTasks,
      requirementCoverage,
      outstandingItems: outstanding.map(t => `${t.id}: ${t.title}`),
    };

    this.synthesisRequested.add(teamId);
    this.emit('synthesis:requested', payload);
  }
}

/** Singleton team manager */
export const teamManager = new AgentTeamManager();
