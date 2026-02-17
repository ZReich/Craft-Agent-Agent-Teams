/**
 * Teammate Health Monitor
 *
 * Monitors teammate health by detecting stalls, error loops, retry storms,
 * and context exhaustion. Runs periodic checks and emits events when issues
 * are detected so the team lead can intervene.
 *
 * This module uses only Node.js built-ins (EventEmitter, timers).
 */

import { EventEmitter } from 'events';

// ============================================================
// Configuration
// ============================================================

export interface HealthMonitorConfig {
  /** Time with no activity before a teammate is considered stalled (ms). Default: 5 * 60 * 1000 (5 min) */
  stallTimeoutMs: number;
  /** Number of consecutive errors on same tool before flagging error loop. Default: 3 */
  errorLoopThreshold: number;
  /** Number of identical/similar tool calls before flagging retry storm. Default: 5 */
  retryStormThreshold: number;
  /** How often to run health checks (ms). Default: 30 * 1000 (30 sec) */
  checkIntervalMs: number;
  /** Context window usage percentage that triggers a warning. Default: 0.85 (85%) */
  contextWarningThreshold: number;
  /** Optional adaptive tool-call throttle config. When provided, teammate sessions
   *  use TCP slow-start / AIMD congestion control to prevent retry storms proactively. */
  throttle?: Partial<import('./tool-call-throttle.ts').ThrottleConfig>;
}

export const DEFAULT_HEALTH_CONFIG: HealthMonitorConfig = {
  stallTimeoutMs: 5 * 60 * 1000,
  errorLoopThreshold: 3,
  retryStormThreshold: 5,
  checkIntervalMs: 30 * 1000,
  contextWarningThreshold: 0.85,
};

// ============================================================
// Types
// ============================================================

export type HealthIssueType = 'stall' | 'error-loop' | 'retry-storm' | 'retry-storm-throttle' | 'retry-storm-kill' | 'context-exhaustion';

/** Implements REQ-B1: 3-stage retry storm escalation */
export type RetryStormStage = 'none' | 'warned' | 'throttled' | 'killed';

export interface HealthIssue {
  type: HealthIssueType;
  teammateId: string;
  teammateName: string;
  taskId?: string;
  details: string;
  detectedAt: string;
  /** How long the issue has persisted (ms) */
  duration?: number;
  /** The tool that triggered the issue (for retry-storm events) */
  toolName?: string;
}

export interface TeammateHealthState {
  teammateId: string;
  teammateName: string;
  lastActivityAt: string;
  currentTaskId?: string;
  consecutiveErrors: number;
  lastErrorTool?: string;
  recentToolCalls: Array<{ tool: string; input: string; timestamp: string }>;
  /** Phase 4a: Captured tool results so killed agents' partial work isn't fully lost */
  recentToolResults: Array<{ tool: string; resultPreview: string; timestamp: string; isError: boolean }>;
  contextUsage?: number; // 0-1 percentage
  issues: HealthIssue[];
  /** Implements REQ-B1: Current retry storm escalation stage */
  retryStormStage: RetryStormStage;
  /** Running count of similar consecutive tool calls for retry storm detection */
  retryStormCount: number;
}

export interface TeammateActivity {
  type: 'tool_call' | 'tool_result' | 'message' | 'task_update';
  toolName?: string;
  toolInput?: string;
  error?: boolean;
  taskId?: string;
  /** Phase 4a: Preview of tool result (for partial work recovery on kill) */
  resultPreview?: string;
}

// ============================================================
// Constants
// ============================================================

/** Maximum number of recent tool calls to retain per teammate */
const MAX_RECENT_TOOL_CALLS = 20;

/** Minimum interval between emitting the same issue type for the same teammate (ms) */
const DEBOUNCE_INTERVAL_MS = 2 * 60 * 1000;

/** Maximum number of retained health issues per teammate */
const MAX_RETAINED_ISSUES = 20;

// ============================================================
// TeammateHealthMonitor
// ============================================================

export class TeammateHealthMonitor extends EventEmitter {
  private readonly config: HealthMonitorConfig;

  /** teamId -> teammateId -> health state */
  private readonly states: Map<string, Map<string, TeammateHealthState>> = new Map();

  /** teamId -> interval handle */
  private readonly intervals: Map<string, NodeJS.Timeout> = new Map();

  /** issueKey -> last emitted timestamp (for debouncing) */
  private readonly lastEmitted: Map<string, number> = new Map();

  constructor(config?: Partial<HealthMonitorConfig>) {
    super();
    this.config = { ...DEFAULT_HEALTH_CONFIG, ...config };
  }

  // ============================================================
  // Monitoring Lifecycle
  // ============================================================

  /**
   * Start periodic health checks for a team.
   * If monitoring is already active for this team, this is a no-op.
   */
  startMonitoring(teamId: string): void {
    if (this.intervals.has(teamId)) return;

    const interval = setInterval(() => {
      this.checkHealth(teamId);
    }, this.config.checkIntervalMs);

    // Ensure the interval does not prevent process exit
    if (typeof interval.unref === 'function') {
      interval.unref();
    }

    this.intervals.set(teamId, interval);

    if (!this.states.has(teamId)) {
      this.states.set(teamId, new Map());
    }
  }

  /**
   * Stop periodic health checks for a team.
   */
  stopMonitoring(teamId: string): void {
    const interval = this.intervals.get(teamId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(teamId);
    }
  }

  /**
   * Remove a teammate from health tracking for a team.
   * Safe no-op if the teammate or team does not exist.
   */
  removeTeammate(teamId: string, teammateId: string): void {
    const teamStates = this.states.get(teamId);
    if (!teamStates) return;

    teamStates.delete(teammateId);

    // Clean up debounce keys for this teammate so stale issue state does not linger.
    for (const key of Array.from(this.lastEmitted.keys())) {
      if (key.startsWith(`${teamId}:${teammateId}:`)) {
        this.lastEmitted.delete(key);
      }
    }
  }

  /**
   * Clear all health tracking state for a specific team.
   * Also stops monitoring interval for that team.
   */
  clearTeam(teamId: string): void {
    this.stopMonitoring(teamId);
    this.states.delete(teamId);

    for (const key of Array.from(this.lastEmitted.keys())) {
      if (key.startsWith(`${teamId}:`)) {
        this.lastEmitted.delete(key);
      }
    }
  }

  // ============================================================
  // Activity Recording
  // ============================================================

  /**
   * Record an activity event for a teammate.
   * Called by the agent/session manager whenever a tool call, result, message,
   * or task update happens.
   */
  recordActivity(
    teamId: string,
    teammateId: string,
    teammateName: string,
    activity: TeammateActivity,
  ): void {
    const state = this.ensureState(teamId, teammateId, teammateName);
    const now = new Date().toISOString();

    state.lastActivityAt = now;

    // Track task assignment
    if (activity.taskId) {
      state.currentTaskId = activity.taskId;
    }

    // Track tool calls in the ring buffer
    if (activity.type === 'tool_call' && activity.toolName) {
      const inputPrefix = (activity.toolInput ?? '').slice(0, 100);

      // Phase 1c: Smart retry-storm reset — if the agent changes tool or input,
      // that's evidence they've changed approach. Reset escalation so they aren't
      // punished for past storm behavior after course-correcting.
      if (state.retryStormStage !== 'none' && state.recentToolCalls.length > 0) {
        const lastCall = state.recentToolCalls[state.recentToolCalls.length - 1]!;
        const isDifferentTool = lastCall.tool !== activity.toolName;
        const isDifferentInput = lastCall.input.slice(0, 100) !== inputPrefix;
        if (isDifferentTool || isDifferentInput) {
          state.retryStormStage = 'none';
          state.retryStormCount = 0;
        }
      }

      state.recentToolCalls.push({
        tool: activity.toolName,
        input: activity.toolInput ?? '',
        timestamp: now,
      });

      // Ring buffer: keep only the last N entries
      if (state.recentToolCalls.length > MAX_RECENT_TOOL_CALLS) {
        state.recentToolCalls.splice(0, state.recentToolCalls.length - MAX_RECENT_TOOL_CALLS);
      }
    }

    // Track consecutive errors + capture results for partial work recovery
    if (activity.type === 'tool_result') {
      if (activity.error && activity.toolName) {
        if (state.lastErrorTool === activity.toolName) {
          state.consecutiveErrors++;
        } else {
          state.consecutiveErrors = 1;
          state.lastErrorTool = activity.toolName;
        }
      } else {
        // Successful result resets the error counter
        state.consecutiveErrors = 0;
        state.lastErrorTool = undefined;
      }

      // Phase 4a: Capture non-error tool results for partial work recovery.
      // When an agent gets killed, these previews let us surface what they found.
      if (activity.resultPreview && activity.toolName && !activity.error) {
        state.recentToolResults.push({
          tool: activity.toolName,
          resultPreview: activity.resultPreview,
          timestamp: now,
          isError: !!activity.error,
        });
        // Keep only last N results (same cap as tool calls)
        if (state.recentToolResults.length > MAX_RECENT_TOOL_CALLS) {
          state.recentToolResults.splice(0, state.recentToolResults.length - MAX_RECENT_TOOL_CALLS);
        }
      }
    }
  }

  /**
   * Update the context window usage percentage for a teammate.
   * @param usage A value between 0 and 1 representing percentage used.
   */
  recordContextUsage(teamId: string, teammateId: string, usage: number): void {
    const teamStates = this.states.get(teamId);
    if (!teamStates) return;

    const state = teamStates.get(teammateId);
    if (!state) return;

    state.contextUsage = Math.max(0, Math.min(1, usage));
  }

  // ============================================================
  // Health Queries
  // ============================================================

  /**
   * Get the throttle config overrides (for creating ToolCallThrottle instances).
   */
  getThrottleConfig(): Partial<import('./tool-call-throttle.ts').ThrottleConfig> | undefined {
    return this.config.throttle;
  }

  /**
   * Get the current health state for a specific teammate.
   */
  getHealth(teamId: string, teammateId: string): TeammateHealthState | undefined {
    return this.states.get(teamId)?.get(teammateId);
  }

  /**
   * Get health states for all teammates in a team.
   */
  getTeamHealth(teamId: string): TeammateHealthState[] {
    const teamStates = this.states.get(teamId);
    if (!teamStates) return [];
    return Array.from(teamStates.values());
  }

  // ============================================================
  // Health Check Logic (Private)
  // ============================================================

  /**
   * Run health checks for all teammates in a team.
   * Detects stalls, error loops, retry storms, and context exhaustion.
   */
  private checkHealth(teamId: string): void {
    const teamStates = this.states.get(teamId);
    if (!teamStates) return;

    const now = Date.now();

    for (const state of teamStates.values()) {
      // --- Stall check ---
      if (state.currentTaskId) {
        const lastActivity = new Date(state.lastActivityAt).getTime();
        const elapsed = now - lastActivity;

        if (elapsed > this.config.stallTimeoutMs) {
          this.emitIssue(teamId, {
            type: 'stall',
            teammateId: state.teammateId,
            teammateName: state.teammateName,
            taskId: state.currentTaskId,
            details: `No activity for ${Math.round(elapsed / 1000)}s while working on task ${state.currentTaskId}`,
            detectedAt: new Date().toISOString(),
            duration: elapsed,
          });
        }
      }

      // --- Error loop check ---
      if (
        state.consecutiveErrors >= this.config.errorLoopThreshold &&
        state.lastErrorTool
      ) {
        this.emitIssue(teamId, {
          type: 'error-loop',
          teammateId: state.teammateId,
          teammateName: state.teammateName,
          taskId: state.currentTaskId,
          details: `${state.consecutiveErrors} consecutive errors on tool "${state.lastErrorTool}"`,
          detectedAt: new Date().toISOString(),
        });
      }

      // --- Retry storm check ---
      this.checkRetryStorm(teamId, state);

      // --- Context exhaustion check ---
      if (
        state.contextUsage !== undefined &&
        state.contextUsage >= this.config.contextWarningThreshold
      ) {
        this.emitIssue(teamId, {
          type: 'context-exhaustion',
          teammateId: state.teammateId,
          teammateName: state.teammateName,
          taskId: state.currentTaskId,
          details: `Context window usage at ${Math.round(state.contextUsage * 100)}% (threshold: ${Math.round(this.config.contextWarningThreshold * 100)}%)`,
          detectedAt: new Date().toISOString(),
        });
      }
    }
  }

  /** High-volume research tools that get higher retry storm thresholds */
  private static readonly RESEARCH_TOOLS = new Set([
    'WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob',
  ]);

  /**
   * Implements REQ-B1: 3-stage retry storm escalation.
   *
   * Stage 1 (warn):     At threshold (5 normal / 10 research), emit 'retry-storm'
   *                      with guidance message for the agent to try a different approach.
   * Stage 2 (throttle): At threshold+3 (8 normal / 13 research), emit 'retry-storm-throttle'
   *                      signaling the session layer should add a 30s delay.
   * Stage 3 (kill):     At threshold+7 (12 normal / 17 research), emit 'retry-storm-kill'
   *                      signaling the session layer should force-abort the teammate.
   */
  private checkRetryStorm(teamId: string, state: TeammateHealthState): void {
    const calls = state.recentToolCalls;
    if (calls.length < this.config.retryStormThreshold) return;

    // Count consecutive similar calls from the end
    const lastCall = calls[calls.length - 1];
    if (!lastCall) return;

    const lastTool = lastCall.tool;
    const inputPrefix = lastCall.input.slice(0, 100);
    let similarCount = 0;
    for (let i = calls.length - 1; i >= 0; i--) {
      const call = calls[i]!;
      if (call.tool === lastTool && call.input.slice(0, 100) === inputPrefix) {
        similarCount++;
      } else {
        break;
      }
    }

    // Research tools get higher thresholds to avoid false positives
    const isResearchTool = TeammateHealthMonitor.RESEARCH_TOOLS.has(lastTool);
    const warnThreshold = isResearchTool ? 10 : this.config.retryStormThreshold;
    const throttleThreshold = warnThreshold + 3;
    const killThreshold = warnThreshold + 7;

    state.retryStormCount = similarCount;

    if (similarCount >= killThreshold && state.retryStormStage !== 'killed') {
      // Stage 3: Kill
      state.retryStormStage = 'killed';
      this.emitIssue(teamId, {
        type: 'retry-storm-kill',
        teammateId: state.teammateId,
        teammateName: state.teammateName,
        taskId: state.currentTaskId,
        toolName: lastTool,
        details: `${similarCount} similar calls to "${lastTool}" — force-aborting teammate (stage 3/3)`,
        detectedAt: new Date().toISOString(),
      });
    } else if (similarCount >= throttleThreshold && state.retryStormStage !== 'throttled' && state.retryStormStage !== 'killed') {
      // Stage 2: Throttle
      state.retryStormStage = 'throttled';
      this.emitIssue(teamId, {
        type: 'retry-storm-throttle',
        teammateId: state.teammateId,
        teammateName: state.teammateName,
        taskId: state.currentTaskId,
        toolName: lastTool,
        details: `${similarCount} similar calls to "${lastTool}" — throttling agent (stage 2/3). Try a completely different approach.`,
        detectedAt: new Date().toISOString(),
      });
    } else if (similarCount >= warnThreshold && state.retryStormStage === 'none') {
      // Stage 1: Warn
      state.retryStormStage = 'warned';
      this.emitIssue(teamId, {
        type: 'retry-storm',
        teammateId: state.teammateId,
        teammateName: state.teammateName,
        taskId: state.currentTaskId,
        toolName: lastTool,
        details: `${similarCount} similar calls to "${lastTool}" — warning: try a different approach (stage 1/3)`,
        detectedAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Reset the retry storm stage for a teammate.
   * Now primarily triggered internally by recordActivity() when a tool change or
   * input change is detected. Kept public for external callers (e.g., throttle system).
   */
  resetRetryStormStage(teamId: string, teammateId: string): void {
    const state = this.states.get(teamId)?.get(teammateId);
    if (state && state.retryStormStage !== 'none') {
      state.retryStormStage = 'none';
      state.retryStormCount = 0;
    }
  }

  // ============================================================
  // Event Emission (with debouncing)
  // ============================================================

  /**
   * Emit a health issue event, respecting the debounce interval.
   * Also records the issue on the teammate's state.
   */
  private emitIssue(teamId: string, issue: HealthIssue): void {
    const issueKey = `${teamId}:${issue.teammateId}:${issue.type}`;
    const now = Date.now();
    const lastTime = this.lastEmitted.get(issueKey);

    if (lastTime && now - lastTime < DEBOUNCE_INTERVAL_MS) {
      return; // Debounced — don't re-emit
    }

    this.lastEmitted.set(issueKey, now);

    // Record on the teammate's state
    const state = this.states.get(teamId)?.get(issue.teammateId);
    if (state) {
      state.issues.push(issue);
      if (state.issues.length > MAX_RETAINED_ISSUES) {
        state.issues.splice(0, state.issues.length - MAX_RETAINED_ISSUES);
      }
    }

    this.emit(`health:${issue.type}`, issue);
  }

  // ============================================================
  // Internal Helpers
  // ============================================================

  /**
   * Ensure a TeammateHealthState exists for the given teammate, creating one if needed.
   */
  private ensureState(
    teamId: string,
    teammateId: string,
    teammateName: string,
  ): TeammateHealthState {
    if (!this.states.has(teamId)) {
      this.states.set(teamId, new Map());
    }

    const teamStates = this.states.get(teamId)!;

    if (!teamStates.has(teammateId)) {
      teamStates.set(teammateId, {
        teammateId,
        teammateName,
        lastActivityAt: new Date().toISOString(),
        consecutiveErrors: 0,
        recentToolCalls: [],
        recentToolResults: [],
        issues: [],
        retryStormStage: 'none',
        retryStormCount: 0,
      });
    }

    return teamStates.get(teammateId)!;
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Dispose of the monitor: clear all intervals and internal state.
   */
  dispose(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval);
    }
    this.intervals.clear();
    this.states.clear();
    this.lastEmitted.clear();
    this.removeAllListeners();
  }
}
