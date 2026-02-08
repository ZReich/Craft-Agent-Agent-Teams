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
} from '@craft-agent/core/types';

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
}

// ============================================================
// Manager Implementation
// ============================================================

export class AgentTeamManager extends EventEmitter {
  private teams = new Map<string, AgentTeam>();
  private tasks = new Map<string, TeamTask[]>();  // teamId → tasks
  private messages = new Map<string, TeammateMessage[]>();  // teamId → messages
  private activityLog = new Map<string, TeamActivityEvent[]>();  // teamId → activity events

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
    this.emit('team:updated', team);
    this.emit('team:cleanup', teamId);
    this.addActivity(teamId, 'teammate-shutdown', 'Team cleaned up', undefined, undefined);
  }

  /** Get team status */
  getTeam(teamId: string): AgentTeam | undefined {
    return this.teams.get(teamId);
  }

  /** Get all active teams */
  getActiveTeams(): AgentTeam[] {
    return Array.from(this.teams.values()).filter(t => t.status === 'active');
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
  createTask(teamId: string, title: string, description?: string, createdBy?: string): TeamTask {
    const task: TeamTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title,
      description,
      status: 'pending',
      createdAt: new Date().toISOString(),
      createdBy,
    };

    const teamTasks = this.tasks.get(teamId) || [];
    teamTasks.push(task);
    this.tasks.set(teamId, teamTasks);

    this.emit('task:created', task);
    return task;
  }

  /** Update task status */
  updateTaskStatus(teamId: string, taskId: string, status: TeamTaskStatus, assignee?: string): void {
    const teamTasks = this.tasks.get(teamId) || [];
    const task = teamTasks.find(t => t.id === taskId);
    if (!task) return;

    task.status = status;
    if (assignee !== undefined) task.assignee = assignee;
    if (status === 'completed') task.completedAt = new Date().toISOString();

    this.emit('task:updated', task);

    // Add activity
    const activityType: TeamActivityType = status === 'completed' ? 'task-completed'
      : status === 'in_progress' ? 'task-claimed'
      : status === 'failed' ? 'task-failed'
      : 'task-claimed';
    this.addActivity(teamId, activityType, `Task "${task.title}" → ${status}`, undefined, undefined, taskId);
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
    teamMessages.push(msg);
    this.messages.set(teamId, teamMessages);

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
      details,
      teammateId,
      teammateName,
      taskId,
    };

    const log = this.activityLog.get(teamId) || [];
    log.push(event);
    this.activityLog.set(teamId, log);

    this.emit('activity', event);
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
}

/** Singleton team manager */
export const teamManager = new AgentTeamManager();
