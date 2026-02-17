/**
 * Model-Aware Heartbeat Profiles
 *
 * Different AI models have different processing speeds, latency characteristics,
 * and reliability patterns. This module defines per-model profiles that control
 * heartbeat timing, stall detection thresholds, and soft probe intervals.
 *
 * Implements REQ-HB-002: Model-aware stall detection
 *
 * This module has no external dependencies.
 */

// ============================================================
// Types
// ============================================================

export interface ModelHeartbeatProfile {
  /** How long this model typically takes between tool calls (ms) */
  expectedSilenceMs: number;
  /** Soft probe threshold — ask "are you ok?" after this much silence (ms) */
  softProbeMs: number;
  /** Hard stall threshold — escalate to orchestrator after this (ms) */
  hardStallMs: number;
}

// ============================================================
// Default Profiles
// ============================================================

/**
 * Built-in model profiles.
 * Models are matched by prefix (e.g., 'claude-haiku' matches 'claude-haiku-4-5').
 *
 * Fast models expect frequent activity; heavy models may think longer.
 * External models (GPT, Codex) get generous thresholds due to API variability.
 */
const MODEL_PROFILES: Array<{ pattern: string; profile: ModelHeartbeatProfile }> = [
  // Claude Haiku — fast, frequent tool calls expected
  {
    pattern: 'claude-haiku',
    profile: { expectedSilenceMs: 15_000, softProbeMs: 60_000, hardStallMs: 180_000 },
  },
  // Claude Sonnet — medium speed
  {
    pattern: 'claude-sonnet',
    profile: { expectedSilenceMs: 30_000, softProbeMs: 90_000, hardStallMs: 300_000 },
  },
  // Claude Opus — heaviest thinking, may take longer between tool calls
  {
    pattern: 'claude-opus',
    profile: { expectedSilenceMs: 45_000, softProbeMs: 120_000, hardStallMs: 300_000 },
  },
  // GPT models — external API, more latency variance
  {
    pattern: 'gpt-',
    profile: { expectedSilenceMs: 45_000, softProbeMs: 120_000, hardStallMs: 360_000 },
  },
  // OpenAI o-series (reasoning models) — may think very long
  {
    pattern: 'o1',
    profile: { expectedSilenceMs: 60_000, softProbeMs: 150_000, hardStallMs: 420_000 },
  },
  {
    pattern: 'o3',
    profile: { expectedSilenceMs: 60_000, softProbeMs: 150_000, hardStallMs: 420_000 },
  },
  {
    pattern: 'o4',
    profile: { expectedSilenceMs: 60_000, softProbeMs: 150_000, hardStallMs: 420_000 },
  },
  // Codex models — external, can be slow on complex tasks
  {
    pattern: 'codex',
    profile: { expectedSilenceMs: 60_000, softProbeMs: 150_000, hardStallMs: 360_000 },
  },
  // Gemini models
  {
    pattern: 'gemini',
    profile: { expectedSilenceMs: 30_000, softProbeMs: 90_000, hardStallMs: 300_000 },
  },
  // DeepSeek models
  {
    pattern: 'deepseek',
    profile: { expectedSilenceMs: 45_000, softProbeMs: 120_000, hardStallMs: 360_000 },
  },
];

/** Default profile for unknown models — conservative thresholds */
const DEFAULT_PROFILE: ModelHeartbeatProfile = {
  expectedSilenceMs: 30_000,
  softProbeMs: 120_000,
  hardStallMs: 300_000,
};

// ============================================================
// Resolution
// ============================================================

/**
 * Resolve the heartbeat profile for a model ID.
 * Matches model against known patterns (prefix match), then applies
 * any user-provided overrides.
 *
 * @param modelId - The model identifier (e.g., 'claude-sonnet-4-5', 'gpt-5.3-codex')
 * @param overrides - User-provided partial overrides keyed by model ID
 */
export function resolveModelProfile(
  modelId: string,
  overrides?: Record<string, Partial<ModelHeartbeatProfile>>,
): ModelHeartbeatProfile {
  const lowerModel = modelId.toLowerCase();

  // Find matching built-in profile
  let profile = DEFAULT_PROFILE;
  for (const entry of MODEL_PROFILES) {
    if (lowerModel.includes(entry.pattern)) {
      profile = entry.profile;
      break;
    }
  }

  // Apply user overrides if present
  if (overrides) {
    // Try exact match first, then prefix matches
    const userOverride = overrides[modelId] ?? overrides[lowerModel];
    if (userOverride) {
      profile = { ...profile, ...userOverride };
    }
  }

  return profile;
}

/**
 * Get the default profile (for unknown models or fallback).
 */
export function getDefaultProfile(): ModelHeartbeatProfile {
  return { ...DEFAULT_PROFILE };
}
