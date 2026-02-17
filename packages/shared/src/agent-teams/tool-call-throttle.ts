/**
 * Adaptive Tool Call Throttle for Agent Teams
 *
 * Prevents retry storms by applying TCP-inspired congestion control to teammate
 * tool calls. Each tool type gets an independent budget that starts small
 * (slow-start) and grows as the agent proves it's making diverse, productive calls.
 *
 * Algorithm: TCP Slow-Start + AIMD (Additive Increase, Multiplicative Decrease)
 * - Start with a small budget per tool (initialWindow)
 * - Double budget on diverse success (slow-start phase)
 * - Switch to linear growth after hitting ssthresh
 * - Halve budget on detection of similar repeated calls (backoff)
 * - Hard-block after maxBackoffs within windowDuration
 *
 * This module uses only built-in types (no external dependencies).
 */

// ============================================================
// Configuration
// ============================================================

export interface ThrottleConfig {
  /** Initial tool call budget per tool type. Default: 2 */
  initialWindow: number;
  /** Slow-start threshold — switch from exponential to linear growth. Default: 8 */
  ssthresh: number;
  /** Max budget any tool can reach. Default: 15 */
  maxWindow: number;
  /** Sliding window duration (ms). Default: 60_000 (1 min) */
  windowDurationMs: number;
  /** Number of backoffs before hard-blocking a tool. Default: 3 */
  maxBackoffs: number;
  /** Cooldown after backoff (ms). Default: 10_000 (10s) */
  backoffCooldownMs: number;
}

export const DEFAULT_THROTTLE_CONFIG: ThrottleConfig = {
  initialWindow: 2,
  ssthresh: 8,
  maxWindow: 15,
  windowDurationMs: 60_000,
  maxBackoffs: 3,
  backoffCooldownMs: 10_000,
};

// ============================================================
// Internal State
// ============================================================

interface ToolState {
  /** Current allowed calls in the window */
  budget: number;
  /** Calls made in current sliding window */
  callsInWindow: Array<{ timestamp: number; inputPrefix: string }>;
  /** Number of backoffs triggered in the current window */
  backoffCount: number;
  /** Timestamp of first backoff (for tracking backoff window) */
  firstBackoffAt: number;
  /** Currently in cooldown until this timestamp */
  cooldownUntil: number;
  /** In slow-start phase? */
  inSlowStart: boolean;
  /** Hard-blocked? */
  blocked: boolean;
}

// ============================================================
// Check Result
// ============================================================

export interface ThrottleCheckResult {
  allowed: boolean;
  reason?: string;
  waitMs?: number;
}

// ============================================================
// ToolCallThrottle
// ============================================================

export class ToolCallThrottle {
  private config: ThrottleConfig;
  private tools: Map<string, ToolState> = new Map();

  constructor(config?: Partial<ThrottleConfig>) {
    this.config = { ...DEFAULT_THROTTLE_CONFIG, ...config };
  }

  /**
   * Check if a tool call should be allowed.
   * Call this BEFORE executing the tool.
   * Returns { allowed, reason?, waitMs? }
   */
  check(toolName: string, inputPrefix: string): ThrottleCheckResult {
    const state = this.ensureState(toolName);
    const now = Date.now();

    // Prune expired calls from sliding window
    this.pruneWindow(state, now);

    // Also prune backoff count if the window has elapsed since first backoff
    if (state.firstBackoffAt > 0 && now - state.firstBackoffAt > this.config.windowDurationMs) {
      state.backoffCount = 0;
      state.firstBackoffAt = 0;
      state.blocked = false;
    }

    // Hard-blocked?
    if (state.blocked) {
      const customReason = (state as any)._blockReason as string | undefined;
      return {
        allowed: false,
        reason: customReason
          ?? `"${toolName}" is temporarily blocked after ${this.config.maxBackoffs} repeated similar call patterns. Use a different tool or significantly change your approach.`,
      };
    }

    // In cooldown?
    if (now < state.cooldownUntil) {
      return {
        allowed: false,
        reason: `"${toolName}" is in cooldown for ${Math.ceil((state.cooldownUntil - now) / 1000)}s after similar call detection. Try a different approach or tool.`,
        waitMs: state.cooldownUntil - now,
      };
    }

    // Check similarity — are recent calls too similar?
    const similarCount = this.countSimilar(state, inputPrefix);
    if (similarCount >= state.budget) {
      // Multiplicative decrease
      this.backoff(state, now);
      return {
        allowed: false,
        reason: `Too many similar "${toolName}" calls (${similarCount}/${state.budget}). Budget reduced. Try a different query or tool.`,
      };
    }

    // Budget check (total calls of this type in window)
    if (state.callsInWindow.length >= state.budget) {
      return {
        allowed: false,
        reason: `"${toolName}" budget exhausted (${state.callsInWindow.length}/${state.budget} in last ${this.config.windowDurationMs / 1000}s). Wait or use a different tool.`,
      };
    }

    // Record the call immediately so parallel tool calls (fired in the same batch by the
    // agent) see each other's pending calls. Without this, N parallel calls would all see
    // callsInWindow.length=0 and all pass the budget check. recordSuccess() handles only
    // budget growth (no duplicate push).
    state.callsInWindow.push({ timestamp: now, inputPrefix });

    return { allowed: true };
  }

  /**
   * Record a successful, allowed call (call AFTER execution succeeds).
   * Note: The call itself was already recorded in check() as a tentative entry.
   * This method only handles budget growth based on diversity.
   */
  recordSuccess(toolName: string, inputPrefix: string): void {
    const state = this.ensureState(toolName);

    // Additive increase: grow budget on diverse success
    if (!this.isSimilarToRecent(state, inputPrefix)) {
      if (state.inSlowStart) {
        // Slow-start: double
        state.budget = Math.min(state.budget * 2, this.config.ssthresh);
        if (state.budget >= this.config.ssthresh) {
          state.inSlowStart = false;
        }
      } else {
        // Congestion avoidance: linear increase
        state.budget = Math.min(state.budget + 1, this.config.maxWindow);
      }
    }
  }

  /**
   * Record a failed call (error from tool execution).
   */
  recordFailure(toolName: string): void {
    const state = this.ensureState(toolName);
    // Treat errors as congestion signal — halve budget
    state.budget = Math.max(this.config.initialWindow, Math.floor(state.budget / 2));
    state.inSlowStart = false;
  }

  /** Reset all state (e.g., new conversation turn). */
  reset(): void {
    this.tools.clear();
  }

  /**
   * Externally hard-block a specific tool.
   * Used when the health monitor detects a retry-storm and wants to permanently
   * prevent further calls to the offending tool for this session.
   * Implements REQ-THROTTLE-BRIDGE: Feedback bridge between health monitor and throttle.
   */
  hardBlockTool(toolName: string, reason?: string): void {
    const state = this.ensureState(toolName);
    state.blocked = true;
    state.budget = 0;
    state.backoffCount = this.config.maxBackoffs;
    // Store custom block reason if provided
    if (reason) {
      (state as any)._blockReason = reason;
    }
  }

  /** Get current state for a tool (for observability / dashboard). */
  getToolState(toolName: string): { budget: number; callsInWindow: number; blocked: boolean; inCooldown: boolean; inSlowStart: boolean } | undefined {
    const state = this.tools.get(toolName);
    if (!state) return undefined;
    const now = Date.now();
    return {
      budget: state.budget,
      callsInWindow: state.callsInWindow.length,
      blocked: state.blocked,
      inCooldown: now < state.cooldownUntil,
      inSlowStart: state.inSlowStart,
    };
  }

  // --- Private helpers ---

  private backoff(state: ToolState, now: number): void {
    state.budget = Math.max(1, Math.floor(state.budget / 2));
    state.inSlowStart = false;
    state.cooldownUntil = now + this.config.backoffCooldownMs;

    if (state.backoffCount === 0) {
      state.firstBackoffAt = now;
    }
    state.backoffCount++;

    if (state.backoffCount >= this.config.maxBackoffs) {
      state.blocked = true;
    }
  }

  private countSimilar(state: ToolState, inputPrefix: string): number {
    return state.callsInWindow.filter(c => c.inputPrefix === inputPrefix).length;
  }

  private isSimilarToRecent(state: ToolState, inputPrefix: string): boolean {
    // Skip the last entry (-1) because check() pushes the current call as a tentative
    // entry. We want to compare against the 3 entries BEFORE this call to determine
    // if the agent is being diverse.
    const recent = state.callsInWindow.slice(-4, -1);
    return recent.some(c => c.inputPrefix === inputPrefix);
  }

  private pruneWindow(state: ToolState, now: number): void {
    const cutoff = now - this.config.windowDurationMs;
    state.callsInWindow = state.callsInWindow.filter(c => c.timestamp > cutoff);
  }

  private ensureState(toolName: string): ToolState {
    if (!this.tools.has(toolName)) {
      this.tools.set(toolName, {
        budget: this.config.initialWindow,
        callsInWindow: [],
        backoffCount: 0,
        firstBackoffAt: 0,
        cooldownUntil: 0,
        inSlowStart: true,
        blocked: false,
      });
    }
    return this.tools.get(toolName)!;
  }
}
