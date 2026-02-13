/**
 * YOLO Orchestrator
 *
 * Autonomous execution engine that drives the full spec → execute → verify
 * lifecycle without manual intervention. Chains existing components:
 *
 *   AgentTeamManager (tasks, teammates, messaging)
 *   + ReviewLoopOrchestrator (quality gates, retry cycles, escalation)
 *   + HealthMonitor (stall detection, error loops)
 *   + CheckpointManager (git-based rollback)
 *
 * Two modes:
 *   - "smart": Adapts at runtime — updates specs/tickets based on discoveries
 *   - "fixed": Follows the initial plan without spec mutations
 *
 * Circuit breakers: cost cap, timeout, stall detection, max remediation rounds.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type {
  YoloConfig,
  YoloState,
  YoloPhase,
  TeamTask,
  TeamPhase,
  SpecEvolutionProposal,
  Spec,
} from '@craft-agent/core/types';
import { DEFAULT_YOLO_CONFIG } from '@craft-agent/core/types';
import type { AgentTeamManager } from '../agent/agent-team-manager';
import type { ReviewLoopOrchestrator } from './review-loop';

// ============================================================
// Callback Interface
// ============================================================

/**
 * Callbacks that decouple the orchestrator from concrete implementations.
 * The session layer provides these to connect YOLO to the actual agent runtime.
 */
export interface YoloCallbacks {
  /** Instruct the lead agent to generate a spec from the user objective */
  generateSpec(teamId: string, objective: string): Promise<Spec>;

  /** Instruct the lead agent to decompose a spec into tasks with phase assignments */
  decomposeIntoTasks(teamId: string, spec: Spec): Promise<Array<{
    title: string;
    description: string;
    requirementIds?: string[];
    phase?: string;
    phaseOrder?: number;
    dependencies?: string[];
  }>>;

  /** Spawn teammates and assign tasks for a given phase (or all if no phases) */
  spawnAndAssign(teamId: string, taskIds: string[]): Promise<void>;

  /** Run the integration gate across the full project */
  runIntegrationCheck(teamId: string): Promise<{ passed: boolean; issues: string[] }>;

  /** Instruct the lead agent to synthesize final results */
  synthesize(teamId: string): Promise<string>;

  /** Notify the user/UI of a state change */
  onStateChange(teamId: string, state: YoloState): void;

  /** Request approval for spec changes (smart mode, when requireApprovalForSpecChanges is true) */
  requestApproval?(teamId: string, proposals: SpecEvolutionProposal[]): Promise<SpecEvolutionProposal[]>;
}

// ============================================================
// YOLO Orchestrator
// ============================================================

export class YoloOrchestrator extends EventEmitter {
  private state: YoloState | null = null;
  private teamId: string | null = null;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  private costCheckInterval: ReturnType<typeof setInterval> | null = null;
  private aborted = false;
  private boundHandlers: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  constructor(
    private teamManager: AgentTeamManager,
    private reviewLoop: ReviewLoopOrchestrator,
    private callbacks: YoloCallbacks,
  ) {
    super();
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Start an autonomous YOLO run for a team.
   * This is the main entry point — it drives the full lifecycle.
   */
  async start(teamId: string, objective: string, config: Partial<YoloConfig> = {}): Promise<YoloState> {
    if (this.state && this.state.phase !== 'idle' && this.state.phase !== 'completed' && this.state.phase !== 'aborted') {
      throw new Error(`YOLO is already running (phase: ${this.state.phase})`);
    }

    this.teamId = teamId;
    this.aborted = false;

    const mergedConfig: YoloConfig = { ...DEFAULT_YOLO_CONFIG, ...config };
    this.state = {
      phase: 'idle',
      config: mergedConfig,
      startedAt: new Date().toISOString(),
      remediationRound: 0,
      remediationTaskIds: [],
      pendingSpecChanges: [],
    };

    // Start circuit breakers
    this.startTimeoutBreaker(mergedConfig.timeoutMinutes);
    this.startCostBreaker(teamId, mergedConfig.costCapUsd);

    // Wire up review loop events for auto-remediation
    this.wireReviewEvents();

    this.logActivity('yolo-started', `YOLO ${mergedConfig.mode} mode started — objective: "${objective.slice(0, 100)}"`);

    try {
      await this.runLifecycle(teamId, objective, mergedConfig);
    } catch (err) {
      if (!this.aborted) {
        this.transition('aborted');
        const msg = err instanceof Error ? err.message : String(err);
        this.state.summary = `Aborted due to error: ${msg}`;
        this.logActivity('yolo-aborted', `YOLO aborted: ${msg}`);
      }
    } finally {
      this.cleanup();
    }

    return this.state;
  }

  /**
   * Pause the YOLO run (can be resumed later).
   */
  pause(reason: YoloState['pauseReason'] = 'user-requested'): void {
    if (!this.state || this.state.phase === 'completed' || this.state.phase === 'aborted') return;
    this.state.pauseReason = reason;
    this.transition('paused');
    this.logActivity('yolo-paused', `YOLO paused: ${reason}`);
  }

  /**
   * Abort the YOLO run. Non-reversible.
   */
  abort(reason: string = 'User requested abort'): void {
    this.aborted = true;
    if (this.state) {
      this.state.pauseReason = 'user-requested';
      this.state.summary = reason;
      this.transition('aborted');
      this.logActivity('yolo-aborted', `YOLO aborted: ${reason}`);
    }
    this.cleanup();
  }

  /**
   * Get the current YOLO state.
   */
  getState(): YoloState | null {
    return this.state;
  }

  /**
   * Check if YOLO is currently running.
   */
  isRunning(): boolean {
    return this.state !== null
      && this.state.phase !== 'idle'
      && this.state.phase !== 'completed'
      && this.state.phase !== 'aborted'
      && this.state.phase !== 'paused';
  }

  // ============================================================
  // Core Lifecycle
  // ============================================================

  private async runLifecycle(teamId: string, objective: string, config: YoloConfig): Promise<void> {
    // Phase 1: Generate spec
    this.transition('spec-generation');
    this.checkAborted();
    const spec = await this.callbacks.generateSpec(teamId, objective);
    this.teamManager.setTeamSpec(teamId, spec);

    // Phase 2: Decompose into tasks
    this.transition('task-decomposition');
    this.checkAborted();
    const taskDefs = await this.callbacks.decomposeIntoTasks(teamId, spec);

    // Create tasks from definitions
    const createdTasks: TeamTask[] = [];

    for (const def of taskDefs) {
      const task = this.teamManager.createTask(teamId, def.title, def.description, 'yolo-orchestrator', {
        requirementIds: def.requirementIds,
        dependencies: def.dependencies,
      });
      // Set phase fields
      if (def.phase) {
        task.phase = def.phase;
        task.phaseOrder = def.phaseOrder ?? 0;
      }
      createdTasks.push(task);
    }

    // Build phases from task definitions (pass created tasks so IDs are populated)
    const phases = this.buildPhases(taskDefs, createdTasks);

    // Phase 3: Execute (phase-aware)
    if (phases.length > 0) {
      await this.executeByPhases(teamId, createdTasks, phases, config);
    } else {
      await this.executeFlat(teamId, createdTasks, config);
    }

    if (this.aborted) return;

    // Phase 4: Integration check
    this.transition('integration-check');
    this.checkAborted();
    const integration = await this.callbacks.runIntegrationCheck(teamId);

    if (!integration.passed) {
      // Create remediation tasks for integration failures
      if (config.autoRemediate && this.state!.remediationRound < config.maxRemediationRounds) {
        this.state!.remediationRound++;
        this.transition('remediating');
        this.logActivity('yolo-remediation-created', `Integration failed — remediation round ${this.state!.remediationRound}`);

        const remTask = this.teamManager.createTask(teamId,
          'Fix integration failures',
          `Integration check failed with issues:\n${integration.issues.map(i => `- ${i}`).join('\n')}\n\nFix all issues and ensure the full project compiles and tests pass.`,
          'yolo-orchestrator',
        );
        this.state!.remediationTaskIds.push(remTask.id);

        // Re-execute just the remediation tasks
        await this.executeFlat(teamId, [remTask], config);

        if (this.aborted) return;

        // Re-run integration
        const recheck = await this.callbacks.runIntegrationCheck(teamId);
        if (!recheck.passed) {
          this.state!.summary = `Integration still failing after remediation: ${recheck.issues.join('; ')}`;
          this.logActivity('yolo-aborted', 'Integration failures persist after remediation');
          this.transition('aborted');
          return;
        }
      } else {
        this.state!.summary = `Integration failed: ${integration.issues.join('; ')}`;
        this.transition('aborted');
        this.logActivity('yolo-aborted', 'Integration failed and remediation exhausted or disabled');
        return;
      }
    }

    // Phase 5: Synthesize
    this.transition('synthesizing');
    this.checkAborted();
    const summary = await this.callbacks.synthesize(teamId);
    this.state!.summary = summary;

    // Done
    this.state!.completedAt = new Date().toISOString();
    this.transition('completed');
    this.logActivity('yolo-completed', `YOLO completed — ${createdTasks.length} tasks executed`);
  }

  // ============================================================
  // Phase-Aware Execution
  // ============================================================

  /**
   * Execute tasks grouped by phase. Each phase must complete before the next starts.
   */
  private async executeByPhases(
    teamId: string,
    tasks: TeamTask[],
    phases: TeamPhase[],
    config: YoloConfig,
  ): Promise<void> {
    const sortedPhases = [...phases].sort((a, b) => a.order - b.order);

    for (const phase of sortedPhases) {
      this.checkAborted();

      const phaseTasks = tasks.filter(t => t.phase === phase.id);
      if (phaseTasks.length === 0) continue;

      phase.status = 'in-progress';
      this.logActivity('phase-advanced', `Starting phase: ${phase.name} (${phaseTasks.length} tasks)`);

      // Execute tasks in this phase
      await this.executeFlat(teamId, phaseTasks, config);

      if (this.aborted) return;

      // Verify all tasks in this phase passed
      const allPassed = phaseTasks.every(t => {
        const latest = this.teamManager.getTasks(teamId).find(tt => tt.id === t.id);
        return latest?.status === 'completed';
      });

      if (!allPassed) {
        const failed = phaseTasks.filter(t => {
          const latest = this.teamManager.getTasks(teamId).find(tt => tt.id === t.id);
          return latest?.status !== 'completed';
        });
        phase.status = 'blocked';
        this.logActivity('phase-blocked', `Phase "${phase.name}" blocked — ${failed.length} tasks incomplete`);

        if (config.autoRemediate && this.state!.remediationRound < config.maxRemediationRounds) {
          this.state!.remediationRound++;
          this.transition('remediating');
          // Retry failed tasks
          await this.executeFlat(teamId, failed, config);
          if (this.aborted) return;

          // Re-verify after remediation
          const allPassedAfterRemediation = phaseTasks.every(t => {
            const latest = this.teamManager.getTasks(teamId).find(tt => tt.id === t.id);
            return latest?.status === 'completed';
          });
          if (!allPassedAfterRemediation) {
            phase.status = 'blocked';
            this.state!.summary = `Phase "${phase.name}" still failing after remediation round ${this.state!.remediationRound}`;
            this.transition('aborted');
            this.logActivity('phase-blocked', `Phase "${phase.name}" still blocked after remediation`);
            return;
          }
        } else {
          this.state!.summary = `Phase "${phase.name}" could not complete`;
          this.transition('aborted');
          return;
        }
      }

      phase.status = 'completed';
      phase.completedAt = new Date().toISOString();
    }
  }

  /**
   * Execute a flat list of tasks (no phase ordering).
   * Respects maxConcurrency by batching.
   */
  private async executeFlat(teamId: string, tasks: TeamTask[], config: YoloConfig): Promise<void> {
    this.transition('executing');
    this.checkAborted();

    const taskIds = tasks.map(t => t.id);

    // Spawn teammates and assign work in batches of maxConcurrency
    const batches = this.chunk(taskIds, config.maxConcurrency);

    for (const batch of batches) {
      this.checkAborted();
      await this.callbacks.spawnAndAssign(teamId, batch);

      // Wait for all tasks in this batch to reach a terminal state
      await this.waitForTasks(teamId, batch);
    }
  }

  /**
   * Wait for tasks to reach a terminal state (completed, failed).
   * Polls the team manager every 2 seconds.
   * Times out after 30 minutes to prevent infinite hangs from stuck tasks.
   */
  private async waitForTasks(teamId: string, taskIds: string[]): Promise<void> {
    const POLL_INTERVAL = 2000;
    const MAX_WAIT_MS = 30 * 60 * 1000; // 30 minutes
    const terminalStatuses = new Set(['completed', 'failed']);

    return new Promise<void>((resolve) => {
      const startTime = Date.now();

      const check = (): void => {
        if (this.aborted) {
          resolve();
          return;
        }

        // Timeout guard: resolve if we've been waiting too long
        if (Date.now() - startTime > MAX_WAIT_MS) {
          this.logActivity('yolo-paused', `Task wait timed out after ${MAX_WAIT_MS / 60_000} minutes`);
          resolve();
          return;
        }

        const allTasks = this.teamManager.getTasks(teamId);
        const relevant = allTasks.filter(t => taskIds.includes(t.id));
        const allDone = relevant.every(t => terminalStatuses.has(t.status));

        if (allDone || relevant.length === 0) {
          resolve();
        } else {
          setTimeout(check, POLL_INTERVAL);
        }
      };

      check();
    });
  }

  // ============================================================
  // Auto-Remediation (wired from review loop events)
  // ============================================================

  private wireReviewEvents(): void {
    // When the review loop detects missing requirements, create remediation tasks
    const remediationHandler = (data: {
      teamId: string;
      taskId: string;
      missingRequirements: string[];
    }): void => {
      if (!this.state || this.state.config.mode === 'off') return;
      if (data.teamId !== this.teamId) return;
      if (!this.state.config.autoRemediate) return;

      this.createRemediationTasks(data.teamId, data.missingRequirements, data.taskId);
    };
    this.reviewLoop.on('review:remediation-needed', remediationHandler);
    this.boundHandlers.push({ event: 'review:remediation-needed', handler: remediationHandler as (...args: unknown[]) => void });

    // When the review loop detects spec compliance issues in smart mode,
    // generate spec evolution proposals
    if (this.state?.config.mode === 'smart' && this.state?.config.adaptiveSpecs) {
      const failedHandler = (data: {
        teamId: string;
        taskId: string;
        report: string;
      }): void => {
        if (data.teamId !== this.teamId) return;
        this.proposeSpecEvolution(data.teamId, data.taskId, data.report);
      };
      this.reviewLoop.on('review:failed', failedHandler);
      this.boundHandlers.push({ event: 'review:failed', handler: failedHandler as (...args: unknown[]) => void });
    }
  }

  private createRemediationTasks(teamId: string, missingRequirementIds: string[], sourceTaskId: string): void {
    if (!this.state) return;
    if (this.state.remediationRound >= this.state.config.maxRemediationRounds) {
      this.logActivity('yolo-aborted', `Max remediation rounds (${this.state.config.maxRemediationRounds}) reached`);
      this.pause('max-remediation');
      return;
    }

    const spec = this.teamManager.getTeamSpec(teamId);
    if (!spec) return;

    for (const reqId of missingRequirementIds) {
      const req = spec.requirements.find(r => r.id === reqId);
      if (!req) continue;

      const task = this.teamManager.createTask(teamId,
        `Remediate: ${req.id} — ${req.description.slice(0, 80)}`,
        `Requirement ${req.id} was not fully addressed in the previous implementation.\n\nRequirement: ${req.description}\n\nAcceptance tests: ${req.acceptanceTests.join(', ') || 'None specified'}\n\nPlease implement this requirement fully.`,
        'yolo-orchestrator',
        { requirementIds: [reqId] },
      );

      this.state.remediationTaskIds.push(task.id);
      this.logActivity('yolo-remediation-created', `Remediation task created for ${reqId}: ${task.id}`);
    }
  }

  private proposeSpecEvolution(teamId: string, sourceTaskId: string, failureReport: string): void {
    if (!this.state || this.state.config.mode !== 'smart') return;

    const proposal: SpecEvolutionProposal = {
      id: `sev-${randomUUID().slice(0, 8)}`,
      requirementId: 'new',
      description: `Spec gap discovered during task execution`,
      reason: failureReport.slice(0, 500),
      discoveredBy: 'yolo-orchestrator',
      sourceTaskId,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    this.state.pendingSpecChanges.push(proposal);
    this.logActivity('yolo-spec-evolution-proposed', `Spec evolution proposed from task ${sourceTaskId}`);
    this.emit('yolo:spec-evolution-proposed', { teamId, proposal });
  }

  // ============================================================
  // Circuit Breakers
  // ============================================================

  private startTimeoutBreaker(timeoutMinutes: number): void {
    this.timeoutHandle = setTimeout(() => {
      if (this.isRunning()) {
        this.pause('timeout');
        this.logActivity('yolo-paused', `YOLO paused: ${timeoutMinutes}-minute timeout reached`);
      }
    }, timeoutMinutes * 60 * 1000);
  }

  private startCostBreaker(teamId: string, costCapUsd: number): void {
    this.costCheckInterval = setInterval(() => {
      const cost = this.teamManager.getCostSummary(teamId);
      if (cost.totalCostUsd >= costCapUsd && this.isRunning()) {
        this.pause('cost-cap');
        this.logActivity('yolo-paused', `YOLO paused: cost cap $${costCapUsd.toFixed(2)} reached ($${cost.totalCostUsd.toFixed(2)} spent)`);
      }
    }, 10_000); // Check every 10 seconds
  }

  // ============================================================
  // Helpers
  // ============================================================

  private transition(phase: YoloPhase): void {
    if (!this.state) return;
    this.state.phase = phase;
    if (this.teamId) {
      // Deep copy to prevent consumers from mutating orchestrator state
      this.callbacks.onStateChange(this.teamId, {
        ...this.state,
        remediationTaskIds: [...this.state.remediationTaskIds],
        pendingSpecChanges: this.state.pendingSpecChanges.map(p => ({ ...p })),
      });
    }
    this.emit('yolo:phase-changed', { teamId: this.teamId, phase });
  }

  private checkAborted(): void {
    if (this.aborted) {
      throw new Error('YOLO run was aborted');
    }
  }

  private logActivity(type: string, details: string): void {
    if (!this.teamId) return;
    this.teamManager.logActivity(
      this.teamId,
      type as import('@craft-agent/core/types').TeamActivityType,
      details,
    );
  }

  private buildPhases(taskDefs: Array<{ phase?: string; phaseOrder?: number }>, tasks?: TeamTask[]): TeamPhase[] {
    const phaseMap = new Map<string, TeamPhase>();

    for (const [i, def] of taskDefs.entries()) {
      if (!def || !def.phase) continue;

      const taskId = tasks?.[i]?.id;
      const existing = phaseMap.get(def.phase);
      if (existing) {
        // Use the lowest phaseOrder across all tasks in this phase
        const defOrder = def.phaseOrder ?? 0;
        if (defOrder < existing.order) {
          existing.order = defOrder;
        }
        // Track task ID if available
        if (taskId) {
          existing.taskIds.push(taskId);
        }
      } else {
        phaseMap.set(def.phase, {
          id: def.phase,
          name: def.phase,
          order: def.phaseOrder ?? 0,
          status: 'pending',
          taskIds: taskId ? [taskId] : [],
        });
      }
    }

    return Array.from(phaseMap.values());
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private cleanup(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    if (this.costCheckInterval) {
      clearInterval(this.costCheckInterval);
      this.costCheckInterval = null;
    }
    // Remove only the handlers this orchestrator attached
    for (const { event, handler } of this.boundHandlers) {
      this.reviewLoop.off(event, handler);
    }
    this.boundHandlers = [];
  }
}

// ============================================================
// Config Helpers
// ============================================================

/**
 * Merge partial YOLO config with defaults.
 */
export function mergeYoloConfig(partial?: Partial<YoloConfig>): YoloConfig {
  if (!partial) return { ...DEFAULT_YOLO_CONFIG };
  return { ...DEFAULT_YOLO_CONFIG, ...partial };
}
