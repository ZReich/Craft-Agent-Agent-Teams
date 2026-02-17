import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { QualityGateConfig, QualityGateResult } from '@craft-agent/core/types';
import { getLearningGuidance, recordQualityLearning, applyLearningGuidanceToQualityConfig } from '../learning-store';
import { DEFAULT_QUALITY_GATE_CONFIG } from '../quality-gates';

function buildQualityResult(params: { passed: boolean; aggregateScore: number; errorsScore: number; cycleCount?: number }): QualityGateResult {
  return {
    passed: params.passed,
    aggregateScore: params.aggregateScore,
    cycleCount: params.cycleCount ?? 1,
    maxCycles: 3,
    reviewModel: 'claude-sonnet-4-5',
    reviewProvider: 'anthropic',
    timestamp: new Date().toISOString(),
    stages: {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 3, passedTests: 3, failedTests: 0, skippedTests: 0 },
      architecture: { score: 85, passed: true, issues: [], suggestions: [] },
      simplicity: { score: 88, passed: true, issues: [], suggestions: [] },
      errors: { score: params.errorsScore, passed: params.errorsScore >= 70, issues: [], suggestions: [] },
      completeness: { score: 90, passed: true, issues: [], suggestions: [] },
    },
  };
}

describe('learning-store', () => {
  it('records quality outcomes and produces guidance from recent history', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-learning-'));
    try {
      for (let i = 0; i < 8; i++) {
        recordQualityLearning(
          workspaceRoot,
          buildQualityResult({
            passed: i % 3 !== 0,
            aggregateScore: i % 3 === 0 ? 74 : 88,
            errorsScore: i % 3 === 0 ? 65 : 86,
            cycleCount: i % 2 === 0 ? 2 : 1,
          }),
        );
      }

      const guidance = getLearningGuidance(workspaceRoot);
      expect(guidance.rationale.length).toBeGreaterThan(0);
      expect(typeof guidance.preferManaged).toBe('boolean');
      expect(typeof guidance.tightenErrorBypass).toBe('boolean');
      expect(guidance.preferManaged).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('tightens quality-gate config when guidance requests stricter error bypass', () => {
    const base: QualityGateConfig = {
      ...DEFAULT_QUALITY_GATE_CONFIG,
      passThreshold: 90,
      bypass: {
        enabled: true,
        architecture: { maxDiffLines: 50, maxFilesChanged: 2, allowNewFiles: true, defaultScore: 90 },
        simplicity: { maxDiffLines: 100, maxFunctionLines: 50, defaultScore: 90 },
        errors: { maxDiffLines: 50, requirePassingTests: false, minTestCount: 1, disallowAsyncAwait: false, defaultScore: 90 },
      },
    };

    const tightened = applyLearningGuidanceToQualityConfig(base, {
      preferManaged: true,
      tightenErrorBypass: true,
      rationale: ['failureRate=0.30'],
    });

    expect(tightened.passThreshold).toBeGreaterThanOrEqual(92);
    expect(tightened.bypass?.architecture?.allowNewFiles).toBe(false);
    expect(tightened.bypass?.errors?.requirePassingTests).toBe(true);
    expect((tightened.bypass?.errors?.minTestCount ?? 0)).toBeGreaterThanOrEqual(2);
  });

  it('leaves quality-gate config unchanged when no tightening is needed', () => {
    const base: QualityGateConfig = {
      ...DEFAULT_QUALITY_GATE_CONFIG,
      passThreshold: 90,
    };
    const result = applyLearningGuidanceToQualityConfig(base, {
      preferManaged: false,
      tightenErrorBypass: false,
      rationale: ['stable'],
    });
    expect(result).toBe(base);
  });
});
