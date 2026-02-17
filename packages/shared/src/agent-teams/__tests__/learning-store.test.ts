import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { QualityGateConfig, QualityGateResult } from '@craft-agent/core/types';
import {
  getLearningGuidance,
  recordQualityLearning,
  applyLearningGuidanceToQualityConfig,
  getLearningAdoptionSummary,
  recordKnowledgeTelemetry,
} from '../learning-store';
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

  it('ignores quality events outside retention window when deriving guidance (REQ-009)', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-learning-retention-'));
    try {
      const dir = join(workspaceRoot, '.craft-agent');
      mkdirSync(dir, { recursive: true });
      const now = Date.now();
      const days = (count: number) => count * 24 * 60 * 60 * 1000;
      const oldTimestamp = new Date(now - days(45)).toISOString();
      const recentTimestamp = new Date(now - days(1)).toISOString();

      const oldEvents = Array.from({ length: 12 }, () => ({
        timestamp: oldTimestamp,
        passed: false,
        aggregateScore: 62,
        cycleCount: 3,
        escalated: true,
        architectureScore: 60,
        simplicityScore: 60,
        errorsScore: 55,
        completenessScore: 65,
      }));
      const recentEvents = Array.from({ length: 5 }, () => ({
        timestamp: recentTimestamp,
        passed: true,
        aggregateScore: 92,
        cycleCount: 1,
        escalated: false,
        architectureScore: 90,
        simplicityScore: 91,
        errorsScore: 90,
        completenessScore: 93,
      }));

      writeFileSync(join(dir, 'agent-team-learning.json'), JSON.stringify({
        version: 1,
        qualityEvents: [...oldEvents, ...recentEvents],
        knowledgeEvents: [],
      }, null, 2), 'utf-8');

      const guidance = getLearningGuidance(workspaceRoot);
      expect(guidance.preferManaged).toBe(false);
      expect(guidance.tightenErrorBypass).toBe(false);
      expect(guidance.rationale[0]).toContain('Insufficient learning history');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('computes adoption outcomes from usage + quality windows (REQ-010)', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-learning-adoption-'));
    try {
      const now = Date.now();
      const days = (count: number) => count * 24 * 60 * 60 * 1000;
      const baselineTs = new Date(now - days(10)).toISOString(); // prior 7-day window
      const currentTs = new Date(now - days(2)).toISOString(); // current 7-day window

      const dir = join(workspaceRoot, '.craft-agent');
      mkdirSync(dir, { recursive: true });
      const baselineQuality = Array.from({ length: 6 }, () => ({
        timestamp: baselineTs,
        passed: false,
        aggregateScore: 74,
        cycleCount: 3,
        escalated: true,
        architectureScore: 70,
        simplicityScore: 72,
        errorsScore: 68,
        completenessScore: 76,
      }));
      const currentQuality = Array.from({ length: 6 }, (_, index) => ({
        timestamp: currentTs,
        passed: index > 0,
        aggregateScore: 90,
        cycleCount: index === 0 ? 2 : 1,
        escalated: false,
        architectureScore: 88,
        simplicityScore: 89,
        errorsScore: 87,
        completenessScore: 91,
      }));
      writeFileSync(join(dir, 'agent-team-learning.json'), JSON.stringify({
        version: 1,
        qualityEvents: [...baselineQuality, ...currentQuality],
        knowledgeEvents: [],
      }, null, 2), 'utf-8');

      for (let i = 0; i < 10; i++) {
        recordKnowledgeTelemetry(workspaceRoot, {
          operation: 'query',
          scope: 'prompt-context',
          hit: true,
          resultCount: 2,
        });
      }
      for (let i = 0; i < 6; i++) {
        recordKnowledgeTelemetry(workspaceRoot, {
          operation: 'inject',
          scope: 'prompt-context',
          hit: i < 4,
          resultCount: i < 4 ? 2 : 0,
        });
      }

      const summary = getLearningAdoptionSummary(workspaceRoot, Date.now() + 1_000);
      expect(summary.current.runs).toBeGreaterThanOrEqual(6);
      expect(summary.current.queryCount).toBeGreaterThanOrEqual(8);
      expect(summary.current.injectionHitRate).not.toBeNull();
      expect(summary.current.passRate).toBeGreaterThan(summary.baseline.passRate);
      expect(summary.current.retryRate).toBeLessThan(summary.baseline.retryRate);
      expect(summary.success).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
