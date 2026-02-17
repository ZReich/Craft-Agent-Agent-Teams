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
  deterministicAnchors: { enabled: false, weight: 0.3 },
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
    design_compliance: { enabled: false, weight: 15 },
  },
};

const taskContext = {
  taskDescription: 'Validate credential fallback handling',
  workingDirectory: process.cwd(),
} as const;

const stageJson = '{"score":95,"issues":[],"suggestions":[]}';

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

describe('QualityGateRunner Phase 1 behavior (REQ-NEXT-009/012/013)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a single combined AI review call by default when stages 3-6 are enabled', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const callSpy = vi.spyOn(
      runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> },
      'callReviewModel',
    ).mockResolvedValue(JSON.stringify({
      architecture: { score: 92, issues: [], suggestions: [] },
      simplicity: { score: 91, issues: [], suggestions: [] },
      errors: { score: 93, issues: [], suggestions: [] },
      completeness: { score: 94, integrationVerified: true, issues: [], suggestions: [] },
    }));

    const result = await runner.runPipeline(
      'diff --git a/src/app.ts b/src/app.ts\n+export const x = 1;',
      taskContext,
      { ...baseConfig, useCombinedReview: true },
    );

    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(result.stages.architecture.score).toBe(92);
    expect(result.stages.simplicity.score).toBe(91);
    expect(result.stages.errors.score).toBe(93);
    expect(result.stages.completeness.score).toBe(94);
  });

  it('falls back to per-stage calls when combined response is partial', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    let callCount = 0;
    vi.spyOn(
      runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> },
      'callReviewModel',
    ).mockImplementation(async () => {
      callCount += 1;
      if (callCount === 1) {
        return JSON.stringify({
          architecture: { score: 88, issues: [], suggestions: [] },
        });
      }
      return stageJson;
    });

    const result = await runner.runPipeline(
      'diff --git a/src/app.ts b/src/app.ts\n+export const x = 1;',
      taskContext,
      { ...baseConfig, useCombinedReview: true },
    );

    // 1 combined + 3 fallback stage calls
    expect(callCount).toBe(4);
    expect(result.stages.architecture.score).toBe(88);
    expect(result.stages.simplicity.score).toBe(95);
    expect(result.stages.errors.score).toBe(95);
    expect(result.stages.completeness.score).toBe(95);
  });

  it('bypasses low-risk architecture/simplicity/errors stages and marks report transparently', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const callSpy = vi.spyOn(
      runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> },
      'callReviewModel',
    ).mockResolvedValue('{"score":91,"integrationVerified":true,"issues":[],"suggestions":[]}');

    const result = await runner.runPipeline(
      'diff --git a/src/app.ts b/src/app.ts\n+export const x = 1;\n+export function y() { return x; }',
      taskContext,
      {
        ...baseConfig,
        useCombinedReview: true,
        bypass: {
          enabled: true,
          architecture: { maxDiffLines: 50, maxFilesChanged: 2, allowNewFiles: false, defaultScore: 90 },
          simplicity: { maxDiffLines: 100, maxFunctionLines: 50, defaultScore: 90 },
          errors: {
            maxDiffLines: 50,
            requirePassingTests: false,
            minTestCount: 0,
            disallowAsyncAwait: true,
            defaultScore: 90,
          },
        },
      },
    );

    // Completeness still runs; other 3 are bypassed
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(result.stages.architecture.suggestions.join(' ')).toContain('Bypassed — low-risk change');
    expect(result.stages.simplicity.suggestions.join(' ')).toContain('Bypassed — low-risk change');
    expect(result.stages.errors.suggestions.join(' ')).toContain('Bypassed — low-risk change');
    expect(result.stages.completeness.score).toBe(91);
  });

  it('scopes diff content per stage to reduce irrelevant prompt input', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const callSpy = vi.spyOn(
      runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> },
      'callReviewModel',
    ).mockResolvedValue(stageJson);

    const config: QualityGateConfig = {
      ...baseConfig,
      useCombinedReview: false,
      stages: {
        ...baseConfig.stages,
        simplicity: { enabled: false, weight: 10 },
        errors: { enabled: false, weight: 25 },
        completeness: { enabled: false, weight: 25 },
      },
    };

    const multiFileDiff = [
      'diff --git a/src/main.ts b/src/main.ts',
      '--- a/src/main.ts',
      '+++ b/src/main.ts',
      '@@ -1,1 +1,2 @@',
      '+export const value = 1;',
      'diff --git a/src/app.test.ts b/src/app.test.ts',
      '--- a/src/app.test.ts',
      '+++ b/src/app.test.ts',
      '@@ -1,1 +1,2 @@',
      '+it("works", () => expect(true).toBe(true));',
      'diff --git a/src/styles.css b/src/styles.css',
      '--- a/src/styles.css',
      '+++ b/src/styles.css',
      '@@ -1,1 +1,2 @@',
      '+.root { color: red; }',
    ].join('\n');

    await runner.runPipeline(multiFileDiff, taskContext, config);
    const userMessage = String(callSpy.mock.calls[0]?.[1] ?? '');
    expect(userMessage).toContain('src/main.ts');
    expect(userMessage).not.toContain('src/app.test.ts');
    expect(userMessage).not.toContain('src/styles.css');
  });
});

describe('QualityGateRunner deterministic anchors (REQ-NEXT-003)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blends architecture/simplicity/errors with deterministic anchor diagnostics', async () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    vi.spyOn(
      runner as unknown as { callReviewModel: (...args: unknown[]) => Promise<string> },
      'callReviewModel',
    ).mockResolvedValue(JSON.stringify({
      architecture: { score: 80, issues: [], suggestions: [] },
      simplicity: { score: 80, issues: [], suggestions: [] },
      errors: { score: 80, issues: [], suggestions: [] },
      completeness: { score: 90, integrationVerified: true, issues: [], suggestions: [] },
    }));

    const result = await runner.runPipeline(
      [
        'diff --git a/src/api/user-service.ts b/src/api/user-service.ts',
        '--- a/src/api/user-service.ts',
        '+++ b/src/api/user-service.ts',
        '@@ -1,1 +1,20 @@',
        '+export async function updateUser(input) {',
        '+  const next = await fetchUser(input.id)',
        '+  if (!next) return null',
        '+  return next',
        '+}',
      ].join('\n'),
      taskContext,
      { ...baseConfig, deterministicAnchors: { enabled: true, weight: 0.3 } },
    );

    expect(result.stages.architecture.suggestions.join(' ')).toContain('Deterministic anchor (architecture)');
    expect(result.stages.simplicity.suggestions.join(' ')).toContain('Deterministic anchor (simplicity)');
    expect(result.stages.errors.suggestions.join(' ')).toContain('Deterministic anchor (errors)');
  });
});

describe('QualityGateRunner simplicity heuristic edge cases', () => {
  it('stops function span at same-indent sibling declarations', () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const diff = [
      'diff --git a/src/sample.ts b/src/sample.ts',
      '--- a/src/sample.ts',
      '+++ b/src/sample.ts',
      '@@ -1,1 +1,12 @@',
      '+export function first() {',
      '+  const a = 1;',
      '+  return a;',
      '+}',
      '+',
      '+export function second() {',
      '+  const b = 2;',
      '+  return b;',
      '+}',
    ].join('\n');

    const max = (
      runner as unknown as { estimateMaxFunctionLinesInDiff: (value: string) => number }
    ).estimateMaxFunctionLinesInDiff(diff);

    expect(max).toBe(5);
  });

  it('returns zero when no added function-like declaration exists', () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const diff = [
      'diff --git a/src/sample.ts b/src/sample.ts',
      '--- a/src/sample.ts',
      '+++ b/src/sample.ts',
      '@@ -1,1 +1,5 @@',
      '+export const status = "ok";',
      '+export const answer = 42;',
      '+const label = status + answer;',
    ].join('\n');

    const max = (
      runner as unknown as { estimateMaxFunctionLinesInDiff: (value: string) => number }
    ).estimateMaxFunctionLinesInDiff(diff);

    expect(max).toBe(0);
  });

  it('counts nested control flow inside a single function span', () => {
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => ({ apiKey: 'openai-test' }),
    });

    const diff = [
      'diff --git a/src/sample.ts b/src/sample.ts',
      '--- a/src/sample.ts',
      '+++ b/src/sample.ts',
      '@@ -1,1 +1,16 @@',
      '+export async function hydrateUser(userId: string) {',
      '+  if (!userId) {',
      '+    return null;',
      '+  }',
      '+',
      '+  try {',
      '+    const user = await loadUser(userId);',
      '+    return user?.profile ?? null;',
      '+  } catch (error) {',
      '+    return null;',
      '+  }',
      '+}',
    ].join('\n');

    const max = (
      runner as unknown as { estimateMaxFunctionLinesInDiff: (value: string) => number }
    ).estimateMaxFunctionLinesInDiff(diff);

    expect(max).toBe(12);
  });
});
