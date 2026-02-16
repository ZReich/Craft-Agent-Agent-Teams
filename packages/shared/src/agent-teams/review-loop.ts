/**
 * Review Loop Orchestrator
 *
 * The engine that connects quality gates to the task completion flow.
 * When a teammate marks a task "completed," this orchestrator:
 *   1. Moves the task to "in_review"
 *   2. Collects the diff of the teammate's changes
 *   3. Runs the quality gate pipeline (syntax → tests → AI review)
 *   4. If PASS → marks task completed, emits success event
 *   5. If FAIL → sends feedback to teammate, returns task to in_progress
 *   6. Tracks review cycles and escalates when maxCycles is reached
 *
 * This is the critical missing piece between QualityGateRunner (which can
 * already run all 9 gate stages) and AgentTeamManager (which tracks tasks).
 */

import { EventEmitter } from 'events';
import type {
  QualityGateConfig,
  QualityGateResult,
  TeamTask,
  TaskQualityReport,
  Spec,
} from '@craft-agent/core/types';
import {
  formatFailureReport,
  formatSuccessReport,
  mergeQualityGateConfig,
  inferTaskType,
  shouldSkipQualityGates,
} from './quality-gates';

// ============================================================
// Types
// ============================================================

/**
 * A review currently in progress or completed
 */
export interface ReviewState {
  teamId: string;
  taskId: string;
  teammateId: string;
  teammateName: string;
  /** Current review cycle (1-indexed) */
  cycleCount: number;
  /** Maximum allowed cycles before escalation */
  maxCycles: number;
  /** History of all quality gate results for this task */
  cycleHistory: QualityGateResult[];
  /** Current status of the review */
  status: 'pending' | 'running' | 'awaiting-rework' | 'passed' | 'failed' | 'escalated';
  /** When the first review started */
  startedAt: string;
  /** When the review completed (passed or final failure) */
  completedAt?: string;
}

/**
 * Callback interface for the review loop to interact with external systems.
 * This decouples the orchestrator from concrete implementations.
 */
export interface ReviewLoopCallbacks {
  /** Collect the diff for a task's work */
  collectDiff(teamId: string, taskId: string, workingDirectory: string): Promise<string>;

  /** Run the quality gate pipeline on a diff */
  runQualityGates(
    diff: string,
    taskDescription: string,
    workingDirectory: string,
    config: QualityGateConfig,
    cycleCount: number,
    spec?: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
  ): Promise<QualityGateResult>;

  /** Send feedback message to a teammate */
  sendFeedback(teamId: string, teammateId: string, feedback: string): Promise<void>;

  /** Update a task's status in the team manager */
  updateTaskStatus(
    teamId: string,
    taskId: string,
    status: string,
    assignee?: string,
    options?: { bypassReviewLoop?: boolean },
  ): void;

  /** Run escalation and get diagnosis */
  escalate(
    result: QualityGateResult,
    diff: string,
    taskDescription: string,
    config: QualityGateConfig,
  ): Promise<string>;

  /** Create a checkpoint before review (optional) */
  createCheckpoint?(teamId: string, taskId: string, label: string, type: string, teammateId?: string): Promise<void>;

  /** Rollback to a checkpoint (optional, used on max cycle failure) */
  rollback?(teamId: string, taskId: string): Promise<void>;

  /** Log an audit entry (optional) */
  auditLog?(entry: { type: string; teamId: string; taskId?: string; teammateId?: string; cycleNumber?: number; data: Record<string, unknown> }): Promise<void>;
}

export interface ReviewLoopConfig {
  /** Quality gate configuration (merged with defaults if partial) */
  qualityGates: QualityGateConfig;
  /** Working directory for local checks (tsc, vitest) */
  workingDirectory: string;
  /** Active SDD spec (optional) */
  spec?: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>;
  /** Whether to auto-enqueue reviews when tasks complete. Default: true */
  autoReview: boolean;
}

// ============================================================
// Review Loop Orchestrator
// ============================================================

export class ReviewLoopOrchestrator extends EventEmitter {
  private static readonly MAX_QUEUE_DEPTH = 50;
  private reviews = new Map<string, ReviewState>();  // taskId → ReviewState
  private callbacks: ReviewLoopCallbacks;
  private config: ReviewLoopConfig;
  private queue: Array<{ teamId: string; taskId: string; task: TeamTask }> = [];
  private processing = false;

  constructor(callbacks: ReviewLoopCallbacks, config: ReviewLoopConfig) {
    super();
    this.callbacks = callbacks;
    this.config = {
      ...config,
      qualityGates: mergeQualityGateConfig(config.qualityGates),
    };
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Enqueue a task for quality gate review.
   * Called when a teammate marks a task as "completed."
   */
  enqueueReview(teamId: string, taskId: string, task: TeamTask): void {
    // Implements REQ-QG-SKIP: Skip quality gates for non-code tasks
    // Research, planning, search, explore, and docs tasks don't produce code
    // and should pass through without running syntax/test/review gates.
    const effectiveType = task.taskType ?? inferTaskType(task.title, task.description);
    if (shouldSkipQualityGates(effectiveType)) {
      this.callbacks.updateTaskStatus(teamId, taskId, 'completed', task.assignee, { bypassReviewLoop: true });
      this.emit('review:skipped', {
        teamId,
        taskId,
        teammateId: task.assignee || '',
        reason: `Task type "${effectiveType}" does not require quality gates`,
      });
      return;
    }

    // Don't re-enqueue tasks already being reviewed
    const existing = this.reviews.get(taskId);
    if (existing && (existing.status === 'running' || existing.status === 'passed')) {
      return;
    }

    // Initialize or resume review state
    if (!existing) {
      this.reviews.set(taskId, {
        teamId,
        taskId,
        teammateId: task.assignee || '',
        teammateName: task.assignee || 'unknown',
        cycleCount: 0,
        maxCycles: this.config.qualityGates.maxReviewCycles,
        cycleHistory: [],
        status: 'pending',
        startedAt: new Date().toISOString(),
      });
    } else {
      // Resuming after rework — keep cycle history
      existing.status = 'pending';
    }

    if (this.queue.length >= ReviewLoopOrchestrator.MAX_QUEUE_DEPTH) {
      this.emit('review:queue_full', {
        teamId,
        taskId,
        teammateId: task.assignee || '',
        maxQueueDepth: ReviewLoopOrchestrator.MAX_QUEUE_DEPTH,
      });
      return;
    }

    this.queue.push({ teamId, taskId, task });
    this.processQueue();
  }

  /**
   * Get the current review state for a task.
   */
  getReviewState(taskId: string): ReviewState | undefined {
    return this.reviews.get(taskId);
  }

  /**
   * Get all active reviews for a team.
   */
  getActiveReviews(teamId: string): ReviewState[] {
    return Array.from(this.reviews.values())
      .filter(r => r.teamId === teamId && (r.status === 'running' || r.status === 'pending' || r.status === 'awaiting-rework'));
  }

  /**
   * Get the quality report for a completed task.
   */
  getTaskQualityReport(taskId: string): TaskQualityReport | undefined {
    const review = this.reviews.get(taskId);
    if (!review || review.cycleHistory.length === 0) return undefined;

    const lastResult = review.cycleHistory[review.cycleHistory.length - 1];
    if (!lastResult) return undefined;
    return {
      result: lastResult,
      cycleHistory: review.cycleHistory,
      wasEscalated: review.status === 'escalated',
      disposition: review.status === 'passed' ? 'passed'
        : review.status === 'escalated' ? 'escalated'
        : 'failed-max-cycles',
    };
  }

  /**
   * Check if all reviewed tasks for a team have passed.
   * Used by the integration verification phase.
   */
  allTasksPassed(teamId: string): boolean {
    const teamReviews = Array.from(this.reviews.values())
      .filter(r => r.teamId === teamId);

    if (teamReviews.length === 0) return true;
    return teamReviews.every(r => r.status === 'passed');
  }

  /**
   * Update the config (e.g., when workspace settings change).
   */
  updateConfig(config: Partial<ReviewLoopConfig>): void {
    if (config.qualityGates) {
      this.config.qualityGates = mergeQualityGateConfig(config.qualityGates);
    }
    if (config.workingDirectory !== undefined) this.config.workingDirectory = config.workingDirectory;
    if (config.spec !== undefined) this.config.spec = config.spec;
    if (config.autoReview !== undefined) this.config.autoReview = config.autoReview;
  }

  /**
   * Clean up review state for a team.
   */
  cleanup(teamId: string): void {
    for (const [taskId, review] of this.reviews.entries()) {
      if (review.teamId === teamId) {
        this.reviews.delete(taskId);
      }
    }
    this.queue = this.queue.filter(q => q.teamId !== teamId);
  }

  /**
   * Evict completed/escalated review states to free memory.
   * Implements H3: Auto-evict old review states to prevent unbounded growth.
   * Removes terminal reviews older than maxAgeMs (default 1 hour).
   * Trims cycle history to last 2 entries for remaining terminal reviews.
   */
  evictStaleReviews(maxAgeMs = 60 * 60 * 1000): number {
    let evicted = 0;
    const now = Date.now();
    const terminalStatuses = new Set(['passed', 'escalated', 'failed']);

    for (const [taskId, review] of this.reviews.entries()) {
      if (!terminalStatuses.has(review.status)) continue;

      const startTime = review.startedAt ? new Date(review.startedAt).getTime() : 0;
      if (now - startTime > maxAgeMs) {
        this.reviews.delete(taskId);
        evicted++;
      } else if (review.cycleHistory.length > 2) {
        // Trim cycle history to last 2 entries to save memory
        review.cycleHistory = review.cycleHistory.slice(-2);
      }
    }

    return evicted;
  }

  // ============================================================
  // Core Review Loop
  // ============================================================

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        await this.runReviewCycle(item.teamId, item.taskId, item.task);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Run a single review cycle for a task.
   * This is the heart of the quality enforcement engine.
   */
  private async runReviewCycle(teamId: string, taskId: string, task: TeamTask): Promise<void> {
    const review = this.reviews.get(taskId);
    if (!review) return;

    review.status = 'running';
    review.cycleCount += 1;

    const qgConfig = this.config.qualityGates;
    const workDir = this.config.workingDirectory;

    // --- Emit: review started ---
    this.emit('review:started', {
      teamId,
      taskId,
      teammateId: review.teammateId,
      cycleNumber: review.cycleCount,
    });

    await this.callbacks.auditLog?.({
      type: 'review-cycle-started',
      teamId,
      taskId,
      teammateId: review.teammateId,
      cycleNumber: review.cycleCount,
      data: { maxCycles: review.maxCycles },
    });

    // --- Step 1: Create pre-review checkpoint ---
    await this.callbacks.createCheckpoint?.(teamId, taskId, `pre-review-cycle-${review.cycleCount}`, 'pre-review', review.teammateId);

    // --- Step 2: Collect the diff ---
    let diff: string;
    try {
      diff = await this.callbacks.collectDiff(teamId, taskId, workDir);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit('review:error', { teamId, taskId, error: `Failed to collect diff: ${errorMsg}` });
      review.status = 'awaiting-rework';
      // Send the error as feedback so the teammate knows
      await this.callbacks.sendFeedback(
        teamId,
        review.teammateId,
        `## Quality Gate Review — ERROR\n\nCould not collect diff for review: ${errorMsg}\n\nPlease ensure your changes are saved and try marking the task complete again.`,
      );
      return;
    }

    if (!diff || diff.trim().length === 0) {
      this.emit('review:error', { teamId, taskId, error: 'No diff found — teammate may not have made any changes' });
      review.status = 'awaiting-rework';
      await this.callbacks.sendFeedback(
        teamId,
        review.teammateId,
        `## Quality Gate Review — NO CHANGES DETECTED\n\nNo code changes were found for this task. Please make the required changes and mark the task complete again.`,
      );
      return;
    }

    // --- Step 3: Run quality gate pipeline ---
    let result: QualityGateResult;
    try {
      result = await this.callbacks.runQualityGates(
        diff,
        task.description || task.title,
        workDir,
        qgConfig,
        review.cycleCount,
        this.config.spec,
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.emit('review:error', { teamId, taskId, error: `Quality gate pipeline failed: ${errorMsg}` });
      review.status = 'awaiting-rework';
      await this.callbacks.sendFeedback(
        teamId,
        review.teammateId,
        `## Quality Gate Review — PIPELINE ERROR\n\nThe quality gate pipeline encountered an error: ${errorMsg}\n\nThis may be a temporary infrastructure issue. Please try marking the task complete again.`,
      );
      return;
    }

    // Stamp cycle info onto the result
    result.cycleCount = review.cycleCount;
    result.maxCycles = review.maxCycles;
    review.cycleHistory.push(result);

    // --- Step 4: Evaluate result ---
    if (result.passed) {
      // === PASSED ===
      review.status = 'passed';
      review.completedAt = new Date().toISOString();

      // Create post-pass checkpoint
      await this.callbacks.createCheckpoint?.(teamId, taskId, `post-pass-cycle-${review.cycleCount}`, 'post-pass', review.teammateId);

      // Update task to completed (for real this time)
      this.callbacks.updateTaskStatus(
        teamId,
        taskId,
        'completed',
        review.teammateId,
        { bypassReviewLoop: true },
      );

      // Emit success
      const successReport = formatSuccessReport(result);
      this.emit('review:passed', {
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        aggregateScore: result.aggregateScore,
        report: successReport,
      });

      await this.callbacks.auditLog?.({
        type: 'quality-gate-completed',
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        data: {
          passed: true,
          aggregateScore: result.aggregateScore,
          stages: Object.fromEntries(
            Object.entries(result.stages).map(([name, stage]) => [name, { score: stage.score, passed: stage.passed }])
          ),
        },
      });

    } else if (review.cycleCount >= review.maxCycles) {
      // === MAX CYCLES REACHED — ESCALATE ===
      review.status = 'escalated';
      review.completedAt = new Date().toISOString();

      this.emit('review:escalating', { teamId, taskId, cycleNumber: review.cycleCount });

      await this.callbacks.auditLog?.({
        type: 'escalation-triggered',
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        data: { aggregateScore: result.aggregateScore },
      });

      let escalationReport: string;
      try {
        escalationReport = await this.callbacks.escalate(
          result,
          diff,
          task.description || task.title,
          qgConfig,
        );
      } catch {
        escalationReport = 'Escalation failed — manual review required.';
      }

      // Mark task completed after escalation — do NOT send feedback or return to in_progress
      // as that creates an infinite loop (teammate processes feedback → completes → triggers QG again)
      this.callbacks.updateTaskStatus(teamId, taskId, 'completed', review.teammateId);

      await this.callbacks.auditLog?.({
        type: 'escalation-completed',
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        data: { escalationReport: escalationReport.slice(0, 500) },
      });

      this.emit('review:escalated', {
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        escalationReport,
      });

    } else {
      // === FAILED — SEND FEEDBACK, AWAIT REWORK ===
      review.status = 'awaiting-rework';

      const failureReport = formatFailureReport(result, qgConfig);

      // Send feedback to teammate
      await this.callbacks.sendFeedback(teamId, review.teammateId, failureReport);

      // Return task to in_progress so teammate can rework
      this.callbacks.updateTaskStatus(teamId, taskId, 'in_progress', review.teammateId);

      // --- Auto-remediation: extract missing requirements from spec_compliance ---
      if (result.stages.spec_compliance && !result.stages.spec_compliance.passed) {
        const missingReqs = this.extractMissingRequirements(result);
        if (missingReqs.length > 0) {
          this.emit('review:remediation-needed', {
            teamId,
            taskId,
            teammateId: review.teammateId,
            missingRequirements: missingReqs,
          });
        }
      }

      this.emit('review:failed', {
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        aggregateScore: result.aggregateScore,
        report: failureReport,
      });

      await this.callbacks.auditLog?.({
        type: 'quality-gate-completed',
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        data: {
          passed: false,
          aggregateScore: result.aggregateScore,
          stages: Object.fromEntries(
            Object.entries(result.stages).map(([name, stage]) => [name, { score: stage.score, passed: stage.passed, issueCount: stage.issues.length }])
          ),
        },
      });

      await this.callbacks.auditLog?.({
        type: 'feedback-sent',
        teamId,
        taskId,
        teammateId: review.teammateId,
        cycleNumber: review.cycleCount,
        data: { reportLength: failureReport.length },
      });
    }
  }

  // ============================================================
  // Auto-Remediation Helpers
  // ============================================================

  /**
   * Extract missing requirement IDs from a quality gate result.
   * Parses the spec_compliance stage issues for "Requirement REQ-XXX is not addressed" patterns.
   */
  private extractMissingRequirements(result: QualityGateResult): string[] {
    const specStage = result.stages.spec_compliance;
    if (!specStage) return [];

    const missing: string[] = [];
    const reqPattern = /[Rr]equirement\s+(REQ-\w+)\s+is\s+not\s+addressed/;
    const partialPattern = /[Rr]equirement\s+(REQ-\w+)\s+appears?\s+only\s+partially/;

    for (const issue of specStage.issues) {
      const fullMatch = reqPattern.exec(issue);
      if (fullMatch?.[1]) {
        missing.push(fullMatch[1]);
        continue;
      }
      const partialMatch = partialPattern.exec(issue);
      if (partialMatch?.[1]) {
        missing.push(partialMatch[1]);
      }
    }

    return [...new Set(missing)];
  }
}
