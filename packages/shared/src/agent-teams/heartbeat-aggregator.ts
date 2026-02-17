/**
 * Heartbeat Aggregator for Agent Teams
 *
 * Observes teammate tool call behavior at the session layer and synthesizes
 * periodic heartbeat summaries. Delivers two tiers of updates:
 *   1. UI heartbeats (frequent, IPC-only, zero token cost)
 *   2. LLM summaries (infrequent, sent to lead as messages, costs tokens)
 *
 * Design principle: Observe, don't instruct. We never ask the LLM to send
 * heartbeats — we watch its tool calls and infer activity.
 *
 * Implements REQ-HB-001: Bidirectional Heartbeat Protocol
 *
 * This module uses only Node.js built-ins (EventEmitter, timers).
 */

import { EventEmitter } from 'events';
import type { ModelHeartbeatProfile } from './model-profiles.ts';
import { resolveModelProfile } from './model-profiles.ts';

// ============================================================
// Configuration
// ============================================================

export interface HeartbeatConfig {
  /** How often to flush UI heartbeats (ms). Default: 30_000 (30s) */
  uiFlushIntervalMs: number;
  /** How often to send LLM summaries to the lead (ms). Default: 120_000 (2 min) */
  llmSummaryIntervalMs: number;
  /** Number of tool calls that trigger early UI flush. Default: 5 */
  significantEventThreshold: number;
  /** Enable model-aware stall profiles. Default: true */
  modelAwareProfiles: boolean;
  /** Custom model profiles (merged with defaults) */
  modelProfiles?: Record<string, Partial<ModelHeartbeatProfile>>;
}

export const DEFAULT_HEARTBEAT_CONFIG: HeartbeatConfig = {
  uiFlushIntervalMs: 30_000,
  llmSummaryIntervalMs: 2 * 60_000,
  significantEventThreshold: 5,
  modelAwareProfiles: true,
};

// ============================================================
// Types
// ============================================================

/** Implements REQ-HB-001: Per-agent heartbeat snapshot */
export interface AgentHeartbeat {
  teammateId: string;
  teammateName: string;
  model: string;
  provider: string;
  timestamp: string;
  /** Total tool calls since last flush */
  toolCallsSinceFlush: number;
  /** Name of the last tool called */
  lastToolName: string;
  /** Human-readable activity summary */
  activitySummary: string;
  /** Progress hint extracted from TodoWrite or task updates */
  progressHint?: string;
  /** Estimated progress 0-100 (from todo state if determinable) */
  estimatedProgress?: number;
  /** Context window usage 0-1 (if known) */
  contextUsage?: number;
  /** Whether this agent appears stalled (no activity beyond model's expected silence) */
  appearsStalled: boolean;
}

export type HeartbeatSignificantEvent =
  | 'agent_completed'
  | 'error_loop_detected'
  | 'approach_changed_after_stall'
  | 'context_threshold_crossed';

/** Emitted on flush for UI consumption */
export interface HeartbeatBatchEvent {
  teamId: string;
  heartbeats: AgentHeartbeat[];
  /** If set, this flush was triggered by a significant event rather than the timer */
  triggeredBy?: HeartbeatSignificantEvent;
}

/** Emitted less frequently for LLM delivery to the lead */
export interface HeartbeatLLMSummaryEvent {
  teamId: string;
  summary: string;
  heartbeats: AgentHeartbeat[];
}

// ============================================================
// Internal tracking state per teammate
// ============================================================

interface TeammateTracker {
  teammateId: string;
  teammateName: string;
  model: string;
  provider: string;
  profile: ModelHeartbeatProfile;
  lastActivityAt: number;
  toolCallsSinceFlush: number;
  lastToolName: string;
  lastToolInput: string;
  recentTools: string[];  // Last 5 distinct tool names for activity classification
  progressHint?: string;
  estimatedProgress?: number;
  contextUsage?: number;
  /** Whether we already emitted a soft probe for the current stall period */
  softProbeEmitted: boolean;
}

// ============================================================
// Activity Classification
// ============================================================

// Implements REQ-HB-001: Tool patterns → human-readable summaries
const ACTIVITY_PATTERNS: Array<{ tools: Set<string>; summary: string }> = [
  { tools: new Set(['Edit', 'Write', 'NotebookEdit']), summary: 'Implementing changes' },
  { tools: new Set(['Read', 'Grep', 'Glob']), summary: 'Exploring codebase' },
  { tools: new Set(['WebSearch', 'WebFetch']), summary: 'Researching' },
  { tools: new Set(['TodoWrite']), summary: 'Updating task progress' },
  { tools: new Set(['Task']), summary: 'Delegating to sub-agent' },
];

function classifyActivity(recentTools: string[]): string {
  if (recentTools.length === 0) return 'Starting up';

  // Check the most recent 3 tools for the dominant pattern
  const recent = recentTools.slice(-3);
  for (const pattern of ACTIVITY_PATTERNS) {
    if (recent.some(t => pattern.tools.has(t))) {
      return pattern.summary;
    }
  }

  // Check for test execution via Bash
  const lastTool = recentTools[recentTools.length - 1];
  if (lastTool === 'Bash') return 'Running commands';

  return 'Working';
}

// ============================================================
// HeartbeatAggregator
// ============================================================

export class HeartbeatAggregator extends EventEmitter {
  private readonly config: HeartbeatConfig;

  /** teamId → (teammateId → tracker) */
  private readonly trackers = new Map<string, Map<string, TeammateTracker>>();

  /** teamId → UI flush interval handle */
  private readonly uiIntervals = new Map<string, NodeJS.Timeout>();
  /** teamId → LLM summary interval handle */
  private readonly llmIntervals = new Map<string, NodeJS.Timeout>();

  constructor(config?: Partial<HeartbeatConfig>) {
    super();
    this.config = { ...DEFAULT_HEARTBEAT_CONFIG, ...config };
  }

  // ============================================================
  // Lifecycle
  // ============================================================

  /** Start heartbeat tracking for a team */
  startTracking(teamId: string): void {
    if (this.uiIntervals.has(teamId)) return;

    if (!this.trackers.has(teamId)) {
      this.trackers.set(teamId, new Map());
    }

    // UI flush timer (frequent, low-cost)
    const uiInterval = setInterval(() => {
      this.flushUI(teamId);
    }, this.config.uiFlushIntervalMs);
    if (typeof uiInterval.unref === 'function') uiInterval.unref();
    this.uiIntervals.set(teamId, uiInterval);

    // LLM summary timer (infrequent, costs tokens)
    const llmInterval = setInterval(() => {
      this.flushLLMSummary(teamId);
    }, this.config.llmSummaryIntervalMs);
    if (typeof llmInterval.unref === 'function') llmInterval.unref();
    this.llmIntervals.set(teamId, llmInterval);
  }

  /** Stop heartbeat tracking for a team */
  stopTracking(teamId: string): void {
    const uiInterval = this.uiIntervals.get(teamId);
    if (uiInterval) {
      clearInterval(uiInterval);
      this.uiIntervals.delete(teamId);
    }
    const llmInterval = this.llmIntervals.get(teamId);
    if (llmInterval) {
      clearInterval(llmInterval);
      this.llmIntervals.delete(teamId);
    }
    this.trackers.delete(teamId);
  }

  /** Register a teammate for tracking */
  registerTeammate(
    teamId: string,
    teammateId: string,
    teammateName: string,
    model: string,
    provider: string,
  ): void {
    if (!this.trackers.has(teamId)) {
      this.trackers.set(teamId, new Map());
    }
    const teamTrackers = this.trackers.get(teamId)!;
    if (teamTrackers.has(teammateId)) return;

    const profile = resolveModelProfile(model, this.config.modelProfiles);

    teamTrackers.set(teammateId, {
      teammateId,
      teammateName,
      model,
      provider,
      profile,
      lastActivityAt: Date.now(),
      toolCallsSinceFlush: 0,
      lastToolName: '',
      lastToolInput: '',
      recentTools: [],
      softProbeEmitted: false,
    });
  }

  /** Remove a teammate from tracking */
  removeTeammate(teamId: string, teammateId: string): void {
    this.trackers.get(teamId)?.delete(teammateId);
  }

  // ============================================================
  // Activity Recording
  // ============================================================

  /**
   * Record a tool call from a teammate.
   * Called by sessions.ts on every tool_start for teammate sessions.
   */
  recordToolCall(
    teamId: string,
    teammateId: string,
    toolName: string,
    toolInput: string,
  ): void {
    const tracker = this.trackers.get(teamId)?.get(teammateId);
    if (!tracker) return;

    tracker.lastActivityAt = Date.now();
    tracker.toolCallsSinceFlush++;
    tracker.lastToolName = toolName;
    tracker.lastToolInput = toolInput.slice(0, 200);
    tracker.softProbeEmitted = false; // Activity resets stall probe flag

    // Keep last 5 distinct tool names for activity classification
    if (tracker.recentTools.length === 0 || tracker.recentTools[tracker.recentTools.length - 1] !== toolName) {
      tracker.recentTools.push(toolName);
      if (tracker.recentTools.length > 5) {
        tracker.recentTools.shift();
      }
    }

    // Early flush on significant activity volume
    const teamTrackers = this.trackers.get(teamId);
    if (teamTrackers) {
      const totalSinceFlush = Array.from(teamTrackers.values())
        .reduce((sum, t) => sum + t.toolCallsSinceFlush, 0);
      if (totalSinceFlush >= this.config.significantEventThreshold) {
        this.flushUI(teamId);
      }
    }
  }

  /**
   * Record a progress update (typically from TodoWrite interception).
   */
  recordProgressUpdate(
    teamId: string,
    teammateId: string,
    progressHint: string,
    estimatedProgress?: number,
  ): void {
    const tracker = this.trackers.get(teamId)?.get(teammateId);
    if (!tracker) return;

    tracker.progressHint = progressHint;
    if (estimatedProgress !== undefined) {
      tracker.estimatedProgress = Math.max(0, Math.min(100, estimatedProgress));
    }
  }

  /**
   * Record context usage update for a teammate.
   */
  recordContextUsage(teamId: string, teammateId: string, usage: number): void {
    const tracker = this.trackers.get(teamId)?.get(teammateId);
    if (!tracker) return;

    const previousUsage = tracker.contextUsage ?? 0;
    tracker.contextUsage = Math.max(0, Math.min(1, usage));

    // Significant event: context crossed 70% threshold
    if (previousUsage < 0.7 && tracker.contextUsage >= 0.7) {
      this.flushUI(teamId, 'context_threshold_crossed');
    }
  }

  /**
   * Signal that an agent has completed.
   * Triggers an immediate flush so the UI updates promptly.
   */
  signalAgentCompleted(teamId: string, teammateId: string): void {
    this.removeTeammate(teamId, teammateId);
    this.flushUI(teamId, 'agent_completed');
  }

  /**
   * Signal that an error loop was detected for an agent.
   */
  signalErrorLoop(teamId: string): void {
    this.flushUI(teamId, 'error_loop_detected');
  }

  // ============================================================
  // Queries
  // ============================================================

  /**
   * Get the model-aware profile for a teammate.
   * Used by the health monitor for soft probe thresholds.
   */
  getTeammateProfile(teamId: string, teammateId: string): ModelHeartbeatProfile | undefined {
    return this.trackers.get(teamId)?.get(teammateId)?.profile;
  }

  /** Get current heartbeat snapshots for a team */
  getHeartbeats(teamId: string): AgentHeartbeat[] {
    return this.buildHeartbeats(teamId);
  }

  // ============================================================
  // Flush Logic
  // ============================================================

  /** Flush UI heartbeats for a team. Emits 'heartbeat:batch'. */
  private flushUI(teamId: string, triggeredBy?: HeartbeatSignificantEvent): void {
    const heartbeats = this.buildHeartbeats(teamId);
    if (heartbeats.length === 0) return;

    // Reset per-flush counters
    const teamTrackers = this.trackers.get(teamId);
    if (teamTrackers) {
      for (const tracker of teamTrackers.values()) {
        tracker.toolCallsSinceFlush = 0;
      }
    }

    const event: HeartbeatBatchEvent = { teamId, heartbeats, triggeredBy };
    this.emit('heartbeat:batch', event);
  }

  /**
   * Flush LLM summary for a team. Emits 'heartbeat:llm-summary'.
   * This is the message that actually gets sent to the lead agent.
   */
  private flushLLMSummary(teamId: string): void {
    const heartbeats = this.buildHeartbeats(teamId);
    if (heartbeats.length === 0) return;

    const summary = this.formatLLMSummary(heartbeats);
    const event: HeartbeatLLMSummaryEvent = { teamId, summary, heartbeats };
    this.emit('heartbeat:llm-summary', event);
  }

  /** Build heartbeat snapshots from current tracker state */
  private buildHeartbeats(teamId: string): AgentHeartbeat[] {
    const teamTrackers = this.trackers.get(teamId);
    if (!teamTrackers) return [];

    const now = Date.now();
    const heartbeats: AgentHeartbeat[] = [];

    for (const tracker of teamTrackers.values()) {
      const silenceMs = now - tracker.lastActivityAt;
      const appearsStalled = silenceMs > tracker.profile.softProbeMs;

      // Determine activity summary
      let activitySummary: string;
      if (appearsStalled) {
        activitySummary = 'May be stalled';
      } else if (silenceMs > tracker.profile.expectedSilenceMs && tracker.toolCallsSinceFlush === 0) {
        activitySummary = 'Thinking / generating response';
      } else {
        activitySummary = classifyActivity(tracker.recentTools);
      }

      heartbeats.push({
        teammateId: tracker.teammateId,
        teammateName: tracker.teammateName,
        model: tracker.model,
        provider: tracker.provider,
        timestamp: new Date().toISOString(),
        toolCallsSinceFlush: tracker.toolCallsSinceFlush,
        lastToolName: tracker.lastToolName,
        activitySummary,
        progressHint: tracker.progressHint,
        estimatedProgress: tracker.estimatedProgress,
        contextUsage: tracker.contextUsage,
        appearsStalled,
      });
    }

    return heartbeats;
  }

  /** Format heartbeats into a concise LLM-readable summary */
  private formatLLMSummary(heartbeats: AgentHeartbeat[]): string {
    const lines = heartbeats.map(hb => {
      const elapsed = Date.now() - new Date(hb.timestamp).getTime();
      const elapsedStr = elapsed < 60000
        ? `${Math.round(elapsed / 1000)}s ago`
        : `${Math.round(elapsed / 60000)}m ago`;

      let line = `- **${hb.teammateName}** (${hb.model}): ${hb.activitySummary}`;
      if (hb.progressHint) {
        line += ` — "${hb.progressHint}"`;
      }
      if (hb.contextUsage !== undefined) {
        line += ` | Context: ${Math.round(hb.contextUsage * 100)}%`;
      }
      if (hb.appearsStalled) {
        line += ' ⚠️ possibly stalled';
      }
      return line;
    });

    return `### Team Status Check-In\n${lines.join('\n')}`;
  }

  // ============================================================
  // Soft Probe Support
  // ============================================================

  /**
   * Check if a teammate needs a soft probe (liveness query).
   * Returns true if the teammate has been silent longer than their model's
   * softProbeMs threshold and we haven't already probed them.
   *
   * Implements REQ-HB-002: Model-aware soft probes before hard escalation.
   */
  needsSoftProbe(teamId: string, teammateId: string): boolean {
    const tracker = this.trackers.get(teamId)?.get(teammateId);
    if (!tracker) return false;
    if (tracker.softProbeEmitted) return false;

    const silenceMs = Date.now() - tracker.lastActivityAt;
    return silenceMs > tracker.profile.softProbeMs;
  }

  /** Mark that a soft probe was sent for a teammate */
  markSoftProbeSent(teamId: string, teammateId: string): void {
    const tracker = this.trackers.get(teamId)?.get(teammateId);
    if (tracker) {
      tracker.softProbeEmitted = true;
    }
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /** Dispose of the aggregator — clear all intervals and state */
  dispose(): void {
    for (const interval of this.uiIntervals.values()) clearInterval(interval);
    for (const interval of this.llmIntervals.values()) clearInterval(interval);
    this.uiIntervals.clear();
    this.llmIntervals.clear();
    this.trackers.clear();
    this.removeAllListeners();
  }
}
