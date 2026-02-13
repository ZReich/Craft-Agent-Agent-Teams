import { describe, it, expect } from 'bun:test';
import type { QualityGateResult } from '@craft-agent/core/types';
import { DEFAULT_QUALITY_GATE_CONFIG, formatSuccessReport, shouldPass } from '../src/agent-teams/quality-gates';

function buildBaseResult(): QualityGateResult {
  return {
    passed: true,
    aggregateScore: 95,
    cycleCount: 1,
    maxCycles: 5,
    reviewModel: 'gpt-5.3-codex',
    reviewProvider: 'openai',
    timestamp: new Date().toISOString(),
    stages: {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: {
        score: 100,
        passed: true,
        issues: [],
        suggestions: [],
        totalTests: 10,
        passedTests: 10,
        failedTests: 0,
        skippedTests: 0,
      },
      architecture: { score: 95, passed: true, issues: [], suggestions: [] },
      simplicity: { score: 95, passed: true, issues: [], suggestions: [] },
      errors: { score: 95, passed: true, issues: [], suggestions: [] },
      completeness: { score: 95, passed: true, issues: [], suggestions: [] },
    },
  };
}

describe('quality gates pass/fail semantics', () => {
  it('fails when any enabled stage fails, even if aggregate score is above threshold', () => {
    const cfg = { ...DEFAULT_QUALITY_GATE_CONFIG };
    const result = buildBaseResult();
    result.aggregateScore = 99;
    result.stages.architecture = { score: 99, passed: false, issues: ['provider error'], suggestions: [] };

    expect(shouldPass(result, cfg)).toBe(false);
  });

  it('marks failed stages as FAIL in success report table rendering', () => {
    const result = buildBaseResult();
    result.stages.errors = { score: 0, passed: false, issues: ['failed'], suggestions: [] };

    const report = formatSuccessReport(result);
    expect(report).toContain('| Error Analysis | 0/100 | FAIL |');
  });
});
