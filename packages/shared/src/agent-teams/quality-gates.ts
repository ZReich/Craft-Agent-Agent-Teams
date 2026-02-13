/**
 * Quality Gates Engine
 *
 * Core logic for the quality gate system: default config, score computation,
 * pass/fail determination, and failure report formatting.
 *
 * This module is pure logic with no side effects — it can be imported
 * anywhere without pulling in Node/Electron dependencies.
 */

import type {
  QualityGateConfig,
  QualityGateResult,
  QualityGateStageResult,
  QualityGateStageName,
  QualityGateStageConfig,
} from '@craft-agent/core/types';
import { resolveReviewProvider } from './review-provider';

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  enabled: true,
  passThreshold: 90,
  maxReviewCycles: 3,
  enforceTDD: true,
  baselineAwareTests: false,
  knownFailingTests: [],
  reviewModel: 'kimi-k2.5',
  reviewProvider: 'moonshot',
  escalationModel: 'claude-sonnet-4-5-20250929',
  escalationProvider: 'anthropic',
  stages: {
    syntax: { enabled: true, weight: 0, binary: true },
    tests: { enabled: true, weight: 20, binary: true },
    architecture: { enabled: true, weight: 25 },
    simplicity: { enabled: true, weight: 10 },
    errors: { enabled: true, weight: 25 },
    completeness: { enabled: true, weight: 25 },
    // SDD stages — only scored when a spec is provided at pipeline runtime
    spec_compliance: { enabled: true, weight: 20 },
    traceability: { enabled: true, weight: 15 },
    rollout_safety: { enabled: false, weight: 10 },
  },
};

// ============================================================
// Score Computation
// ============================================================

/**
 * Compute the weighted aggregate score from individual stage results.
 * Binary stages (syntax, tests) are not included in the weighted average —
 * they act as hard gates that block regardless of score.
 */
export function computeAggregateScore(
  stages: Partial<Record<QualityGateStageName, QualityGateStageResult>>,
  stageConfigs: Record<QualityGateStageName, QualityGateStageConfig>,
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const [name, config] of Object.entries(stageConfigs) as [QualityGateStageName, QualityGateStageConfig][]) {
    if (!config.enabled || config.binary) continue;

    const stageResult = stages[name];
    if (!stageResult) continue;

    totalWeight += config.weight;
    weightedSum += stageResult.score * config.weight;
  }

  if (totalWeight === 0) return 100; // No weighted stages enabled
  return Math.round(weightedSum / totalWeight);
}

// ============================================================
// Pass/Fail Determination
// ============================================================

/**
 * Determine whether a quality gate result passes all checks.
 *
 * Rules:
 * 1. All binary stages must pass (score === 100)
 * 2. Aggregate score must meet or exceed the threshold
 */
export function shouldPass(
  result: QualityGateResult,
  config: QualityGateConfig,
): boolean {
  // All enabled stages that were actually executed must pass.
  // Stages that weren't run (e.g., SDD stages when no spec is active) are skipped.
  for (const [name, stageConfig] of Object.entries(config.stages) as [QualityGateStageName, QualityGateStageConfig][]) {
    if (!stageConfig.enabled) continue;

    const stageResult = result.stages[name];
    if (!stageResult) continue; // Stage wasn't executed — skip
    if (!stageResult.passed) return false;
  }

  // Check binary gates (syntax, tests must be perfect)
  for (const [name, stageConfig] of Object.entries(config.stages) as [QualityGateStageName, QualityGateStageConfig][]) {
    if (!stageConfig.enabled || !stageConfig.binary) continue;

    const stageResult = result.stages[name];
    if (!stageResult) continue; // Stage wasn't executed — skip
    if (!stageResult.passed) return false;
  }

  // Check aggregate score threshold
  return result.aggregateScore >= config.passThreshold;
}

// ============================================================
// Failure Report Formatting
// ============================================================

/**
 * Generate a clear, actionable failure report for the teammate.
 * This is sent back to the teammate so they know exactly what to fix.
 */
export function formatFailureReport(
  result: QualityGateResult,
  config: QualityGateConfig,
): string {
  const lines: string[] = [];

  lines.push(`## Quality Gate Review - FAILED (${result.aggregateScore}% / ${config.passThreshold}% required)`);
  lines.push(`Review cycle ${result.cycleCount}/${result.maxCycles}`);
  lines.push('');
  lines.push('### Phase Scoreboard');
  lines.push(...formatStageScoreboard(result));
  lines.push('');

  // Binary gate failures (most critical - fix these first)
  const binaryFailures: QualityGateStageName[] = [];
  for (const [name, stageConfig] of Object.entries(config.stages) as [QualityGateStageName, QualityGateStageConfig][]) {
    if (!stageConfig.enabled || !stageConfig.binary) continue;
    const stageResult = result.stages[name];
    if (stageResult && !stageResult.passed) {
      binaryFailures.push(name);
    }
  }

  if (binaryFailures.length > 0) {
    lines.push('### BLOCKING Issues (must fix first)');
    for (const name of binaryFailures) {
      const stageResult = result.stages[name];
      if (!stageResult) continue;
      lines.push(`\n**${stageName(name)}** - FAILED`);
      for (const issue of stageResult.issues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push('');
  }

  // Weighted stage issues (improve score)
  const weightedIssues: { name: QualityGateStageName; result: QualityGateStageResult }[] = [];
  for (const [name, stageConfig] of Object.entries(config.stages) as [QualityGateStageName, QualityGateStageConfig][]) {
    if (!stageConfig.enabled || stageConfig.binary) continue;
    const stageResult = result.stages[name];
    if (stageResult && stageResult.issues.length > 0) {
      weightedIssues.push({ name: name as QualityGateStageName, result: stageResult });
    }
  }

  if (weightedIssues.length > 0) {
    lines.push('### Issues to Address');
    for (const { name, result: sr } of weightedIssues) {
      lines.push(`\n**${stageName(name)}** (score: ${sr.score}/100)`);
      for (const issue of sr.issues) {
        lines.push(`- ${issue}`);
      }
      if (sr.suggestions.length > 0) {
        lines.push('\nSuggestions:');
        for (const s of sr.suggestions) {
          lines.push(`- ${s}`);
        }
      }
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Fix the issues above and your work will be re-reviewed automatically.');

  if (result.cycleCount >= result.maxCycles - 1) {
    lines.push(`\n**Warning:** This is cycle ${result.cycleCount}/${result.maxCycles}. If the next review also fails, your work will be escalated to a more capable model for diagnosis.`);
  }

  return lines.join('\n');
}

/**
 * Generate a success report for the lead's review.
 */
export function formatSuccessReport(result: QualityGateResult): string {
  const lines: string[] = [];

  lines.push(`## Quality Gate Review - PASSED (Score: ${result.aggregateScore}%)`);
  if (result.cycleCount > 1) {
    lines.push(`Passed after ${result.cycleCount} review cycle(s)`);
  }
  lines.push('');
  lines.push('### Phase Scoreboard');
  lines.push(...formatStageScoreboard(result));

  // Include suggestions even on pass (for the lead's awareness)
  const allSuggestions: string[] = [];
  for (const [, stageResult] of Object.entries(result.stages)) {
    allSuggestions.push(...(stageResult as QualityGateStageResult).suggestions);
  }

  if (allSuggestions.length > 0) {
    lines.push('');
    lines.push('**Reviewer notes (non-blocking):**');
    for (const s of allSuggestions) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join('\n');
}

// ============================================================
// Helpers
// ============================================================

/** Human-readable stage name */
function stageName(name: QualityGateStageName | string): string {
  const names: Record<string, string> = {
    syntax: 'Syntax & Types',
    tests: 'Test Execution',
    architecture: 'Architecture Review',
    simplicity: 'Simplicity Review',
    errors: 'Error Analysis',
    completeness: 'Completeness Check',
    spec_compliance: 'Spec Compliance',
    traceability: 'Requirement Traceability',
    rollout_safety: 'Rollout Safety',
  };
  return names[name] || name;
}

function formatStageScoreboard(result: QualityGateResult): string[] {
  const orderedStages: QualityGateStageName[] = [
    'syntax',
    'tests',
    'architecture',
    'simplicity',
    'errors',
    'completeness',
    'spec_compliance',
    'traceability',
    'rollout_safety',
  ];

  const lines: string[] = [];
  for (const stageKey of orderedStages) {
    const stageResult = result.stages[stageKey];
    if (!stageResult) continue;
    const status = stageResult.passed ? 'PASS' : 'FAIL';
    const icon = stageResult.passed ? '[PASS]' : '[FAIL]';
    lines.push(`- ${icon} ${stageName(stageKey)}: ${stageResult.score}% (${status})`);
  }
  return lines;
}

/**
 * Merge user config over defaults, preserving any fields the user didn't set.
 */
export function mergeQualityGateConfig(
  userConfig: Partial<QualityGateConfig> | undefined,
): QualityGateConfig {
  if (!userConfig) return { ...DEFAULT_QUALITY_GATE_CONFIG };

  const merged = { ...DEFAULT_QUALITY_GATE_CONFIG, ...userConfig };

  // Deep-merge stages
  if (userConfig.stages) {
    merged.stages = { ...DEFAULT_QUALITY_GATE_CONFIG.stages };
    for (const [name, stageConfig] of Object.entries(userConfig.stages)) {
      if (name in merged.stages && stageConfig) {
        merged.stages[name as QualityGateStageName] = {
          ...DEFAULT_QUALITY_GATE_CONFIG.stages[name as QualityGateStageName],
          ...(stageConfig as QualityGateStageConfig),
        };
      }
    }
  }

  // Clamp pass threshold to avoid impossible settings
  if (typeof merged.passThreshold === 'number') {
    merged.passThreshold = Math.min(95, Math.max(70, merged.passThreshold));
  }

  // If a review model was set without an explicit provider, infer it
  if (!userConfig.reviewProvider && merged.reviewModel) {
    merged.reviewProvider = resolveReviewProvider(merged.reviewModel);
  }

  // Keep escalation provider aligned with escalation model unless user explicitly set it.
  if (!userConfig.escalationProvider && merged.escalationModel) {
    merged.escalationProvider = resolveReviewProvider(merged.escalationModel);
  }

  return merged;
}
