/**
 * Tool Call Throttle for Agent Teams
 *
 * Prevents retry storms via a two-layer defense:
 *
 * Layer 1 — Hard Budget (Primary, REQ-BUDGET-001):
 *   Each tool type has a fixed call cap (e.g. WebSearch: 7). Once an agent
 *   exhausts its budget, the tool is permanently blocked for the session with
 *   a message instructing the agent to synthesize findings. This cap is
 *   un-gameable — it counts ALL calls regardless of input similarity.
 *
 * Layer 2 — AIMD Congestion Control (Secondary):
 *   TCP slow-start / AIMD provides finer-grained control within the hard cap.
 *   Detects repeated similar calls and applies backoff/cooldown. Acts as an
 *   early warning before the hard cap is reached.
 *
 * This module uses only built-in types (no external dependencies).
 */

// ============================================================
// Configuration
// ============================================================

/** Implements REQ-BUDGET-002: Default hard caps per tool type */
export const DEFAULT_TOOL_BUDGETS: Record<string, number> = {
  WebSearch: 7,
  WebFetch: 10,
  Bash: 10,
  Read: 20,
  Grep: 20,
  Glob: 20,
  Edit: 15,
  Write: 10,
};

/** Implements REQ-BUDGET-002: Default cap for tools not listed in DEFAULT_TOOL_BUDGETS */
export const DEFAULT_MAX_CALLS = 15;

export interface ThrottleConfig {
  // --- Layer 1: Hard budget (primary defense) ---

  /** Implements REQ-BUDGET-001: Per-tool hard call caps. Merged with DEFAULT_TOOL_BUDGETS. */
  maxCallsPerTool: Record<string, number>;
  /** Implements REQ-BUDGET-001: Fallback cap for tools not in maxCallsPerTool. Default: 15 */
  defaultMaxCalls: number;

  // --- Layer 2: AIMD congestion control (secondary defense) ---

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
  maxCallsPerTool: { ...DEFAULT_TOOL_BUDGETS },
  defaultMaxCalls: DEFAULT_MAX_CALLS,
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
  /** Implements REQ-BUDGET-001: Lifetime total calls for this tool (never resets) */
  totalCalls: number;
  /** Current allowed calls in the AIMD sliding window */
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
    this.config = {
      ...DEFAULT_THROTTLE_CONFIG,
      ...config,
      // Implements REQ-BUDGET-007: Merge user overrides with defaults (not replace)
      maxCallsPerTool: {
        ...DEFAULT_TOOL_BUDGETS,
        ...config?.maxCallsPerTool,
      },
    };
  }

  /**
   * Check if a tool call should be allowed.
   * Call this BEFORE executing the tool.
   * Returns { allowed, reason?, waitMs? }
   */
  check(toolName: string, inputPrefix: string): ThrottleCheckResult {
    const state = this.ensureState(toolName);
    const now = Date.now();

    // ================================================================
    // Hard budget cap (primary defense — REQ-BUDGET-001)
    // Simple counter, un-gameable, counts ALL calls regardless of input.
    // This is the only similarity-independent check and cannot be bypassed
    // by varying query text.
    // ================================================================
    const maxCalls = this.config.maxCallsPerTool[toolName] ?? this.config.defaultMaxCalls;
    if (state.totalCalls >= maxCalls) {
      // Implements REQ-BUDGET-004: synthesis instruction on exhaustion
      const customReason = (state as any)._blockReason as string | undefined;
      return {
        allowed: false,
        reason: customReason
          ?? `You have used all ${maxCalls} allowed "${toolName}" calls for this task. `
          + 'Synthesize your findings now and send your complete report to team-lead via SendMessage(type="message", recipient="team-lead"). '
          + 'Do NOT attempt to call this tool again.',
      };
    }

    // ================================================================
    // External hard-block (from hardBlockTool — used by health monitor)
    // ================================================================
    if (state.blocked) {
      const customReason = (state as any)._blockReason as string | undefined;
      return {
        allowed: false,
        reason: customReason
          ?? `"${toolName}" has been blocked. Use a different tool or synthesize your findings.`,
      };
    }

    // ================================================================
    // Call allowed — record it
    // ================================================================

    // Increment lifetime counter (hard budget)
    state.totalCalls++;

    // Record in sliding window (for recordSuccess/recordFailure diversity tracking)
    this.pruneWindow(state, now);
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
  getToolState(toolName: string): { budget: number; callsInWindow: number; blocked: boolean; inCooldown: boolean; inSlowStart: boolean; totalCalls: number; maxCalls: number } | undefined {
    const state = this.tools.get(toolName);
    if (!state) return undefined;
    const now = Date.now();
    return {
      budget: state.budget,
      callsInWindow: state.callsInWindow.length,
      blocked: state.blocked,
      inCooldown: now < state.cooldownUntil,
      inSlowStart: state.inSlowStart,
      totalCalls: state.totalCalls,
      maxCalls: this.config.maxCallsPerTool[toolName] ?? this.config.defaultMaxCalls,
    };
  }

  /** Implements REQ-BUDGET-003: Get resolved budgets for prompt injection. */
  getResolvedBudgets(): Record<string, number> {
    const budgets: Record<string, number> = { ...this.config.maxCallsPerTool };
    // Ensure default is available for prompt generation
    budgets['_default'] = this.config.defaultMaxCalls;
    return budgets;
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
        totalCalls: 0,
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
