import { describe, it, expect, vi, afterEach } from 'vitest';
import { QualityGateRunner } from '../quality-gate-runner';
import type { QualityGateConfig } from '@craft-agent/core/types';

const baseConfig: QualityGateConfig = {
  enabled: true,
  passThreshold: 90,
  maxReviewCycles: 3,
  enforceTDD: false,
  reviewModel: 'gpt-5.3-codex',
  reviewProvider: 'openai',
  escalationModel: 'claude-sonnet-4-5-20250929',
  escalationProvider: 'anthropic',
  stages: {
    syntax: { enabled: false, weight: 0, binary: true },
    tests: { enabled: false, weight: 0, binary: true },
    architecture: { enabled: true, weight: 25 },
    simplicity: { enabled: true, weight: 10 },
    errors: { enabled: true, weight: 25 },
    completeness: { enabled: true, weight: 25 },
    spec_compliance: { enabled: false, weight: 20 },
    traceability: { enabled: false, weight: 15 },
    rollout_safety: { enabled: false, weight: 10 },
  },
};

const taskContext = {
  taskDescription: 'Validate credential fallback handling',
  workingDirectory: process.cwd(),
} as const;

describe('QualityGateRunner credential fallback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks AI stages as skipped-passed when no review credentials are configured', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    });

    const result = await runner.runPipeline('diff --git a b', taskContext, baseConfig);

    expect(result.passed).toBe(true);
    expect(result.aggregateScore).toBeGreaterThanOrEqual(baseConfig.passThreshold);

    for (const stageName of ['architecture', 'simplicity', 'errors', 'completeness'] as const) {
      const stage = result.stages[stageName];
      expect(stage.passed).toBe(true);
      expect(stage.score).toBe(100);
      expect(stage.issues).toEqual([]);
      expect(stage.suggestions.join(' ')).toContain('credentials');
    }
  });

  it('falls back from missing OpenAI credentials to Moonshot when available', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => 'moonshot-test-key',
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    });

    vi.spyOn(runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> }, 'callReviewModel')
      .mockResolvedValue('{"score":95,"issues":[],"suggestions":[]}');

    const result = await runner.runPipeline('diff --git a b', taskContext, baseConfig);

    expect(result.passed).toBe(true);
    expect(result.reviewProvider).toBe('moonshot');
    expect(result.reviewModel).toBe('kimi-k2.5');
  });
});

