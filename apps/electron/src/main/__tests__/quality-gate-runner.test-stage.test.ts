import { describe, it, expect, vi, beforeEach } from 'vitest'

const runTypeCheckCached = vi.fn()
const runTestSuiteCached = vi.fn()

vi.mock('@craft-agent/shared/agent-teams/local-checks', () => ({
  runTypeCheckCached,
  runTestSuiteCached,
}))

describe('QualityGateRunner test-stage behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runTypeCheckCached.mockResolvedValue({
      passed: true,
      errorCount: 0,
      errors: [],
      rawOutput: '',
    })
  })

  it('retries once and passes with flaky warning when second attempt succeeds', async () => {
    runTestSuiteCached
      .mockResolvedValueOnce({
        passed: false,
        total: 4,
        passed_count: 3,
        failed: 1,
        skipped: 0,
        failedTests: ['suite flaky test'],
        rawOutput: 'FAIL intermittent',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: true,
        },
      })
      .mockResolvedValueOnce({
        passed: true,
        total: 4,
        passed_count: 4,
        failed: 0,
        skipped: 0,
        failedTests: [],
        rawOutput: '',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: false,
        },
      })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const result = await runner.runTestExecution('C:/repo', false, true)

    expect(result.passed).toBe(true)
    expect(runTestSuiteCached).toHaveBeenCalledTimes(2)
    expect(result.suggestions.join(' ')).toContain('Flaky test behavior detected')
  })

  it('includes deterministic diagnostics when test stage fails', async () => {
    runTestSuiteCached
      .mockResolvedValueOnce({
        passed: false,
        total: 2,
        passed_count: 1,
        failed: 1,
        skipped: 0,
        failedTests: ['suite hard failure'],
        rawOutput: 'FAIL stable',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: true,
        },
      })
      .mockResolvedValueOnce({
        passed: false,
        total: 2,
        passed_count: 1,
        failed: 1,
        skipped: 0,
        failedTests: ['suite hard failure'],
        rawOutput: 'FAIL stable',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: false,
        },
      })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const result = await runner.runTestExecution('C:/repo', false, true)

    expect(result.passed).toBe(false)
    expect(result.issues.join(' ')).toContain('Diagnostics: command=')
    expect(result.issues.join(' ')).toContain('attempt=2/2')
  })

  it('allows zero-test pass when tests are not required for task type', async () => {
    runTestSuiteCached.mockResolvedValue({
      passed: true,
      total: 0,
      passed_count: 0,
      failed: 0,
      skipped: 0,
      failedTests: [],
      rawOutput: '',
      metadata: {
        command: 'bun run vitest run --reporter=json -c vitest.config.ts',
        cwd: 'C:/repo',
        timeoutMs: 120000,
        cacheKey: 'quality:C:/repo:tests',
        cacheHit: false,
      },
    })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const result = await runner.runTestExecution('C:/repo', false, false)

    expect(result.passed).toBe(true)
    expect(result.suggestions.join(' ')).toContain('tests are not required')
  })

  it('suppresses failures when baseline-aware mode marks them as known failures', async () => {
    runTestSuiteCached
      .mockResolvedValueOnce({
        passed: false,
        total: 3,
        passed_count: 1,
        failed: 2,
        skipped: 0,
        failedTests: ['known flaky suite A', 'known flaky suite B'],
        rawOutput: 'FAIL baseline-known',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: true,
        },
      })
      .mockResolvedValueOnce({
        passed: false,
        total: 3,
        passed_count: 1,
        failed: 2,
        skipped: 0,
        failedTests: ['known flaky suite A', 'known flaky suite B'],
        rawOutput: 'FAIL baseline-known',
        metadata: {
          command: 'bun run vitest run --reporter=json -c vitest.config.ts',
          cwd: 'C:/repo',
          timeoutMs: 120000,
          cacheKey: 'quality:C:/repo:tests',
          cacheHit: false,
        },
      })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const result = await runner.runTestExecution('C:/repo', false, true, {
      enabled: true,
      knownFailingTests: ['known flaky suite A', 'known flaky suite B'],
    })

    expect(result.passed).toBe(true)
    expect(result.suggestions.join(' ')).toContain('baseline-aware mode')
  })

  // Implements REQ-015: Feature task + affected scope + 0 tests must fail
  it('fails feature task with zero tests in affected scope when requireTests is true', async () => {
    runTestSuiteCached.mockResolvedValue({
      passed: true,
      total: 0,
      passed_count: 0,
      failed: 0,
      skipped: 0,
      failedTests: [],
      rawOutput: '',
      metadata: {
        command: 'bun run vitest run --reporter=json -c vitest.config.ts --changed',
        cwd: 'C:/repo',
        timeoutMs: 120000,
        cacheKey: 'quality:C:/repo:tests:affected',
        cacheHit: false,
      },
    })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    // requireTests=true (feature), testScope='affected'
    const result = await runner.runTestExecution('C:/repo', false, true, { enabled: false, knownFailingTests: [] }, 'affected')

    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
    expect(result.issues.join(' ')).toContain('feature tasks require tests')
  })

  // Implements REQ-016: Non-feature task + affected scope + 0 tests must pass
  it('passes non-feature task with zero tests in affected scope when requireTests is false', async () => {
    runTestSuiteCached.mockResolvedValue({
      passed: true,
      total: 0,
      passed_count: 0,
      failed: 0,
      skipped: 0,
      failedTests: [],
      rawOutput: '',
      metadata: {
        command: 'bun run vitest run --reporter=json -c vitest.config.ts --changed',
        cwd: 'C:/repo',
        timeoutMs: 120000,
        cacheKey: 'quality:C:/repo:tests:affected',
        cacheHit: false,
      },
    })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    // requireTests=false (docs/refactor), testScope='affected'
    const result = await runner.runTestExecution('C:/repo', false, false, { enabled: false, knownFailingTests: [] }, 'affected')

    expect(result.passed).toBe(true)
    expect(result.score).toBe(100)
  })

  // Implements REQ-011: Failure suggestions reference test-writer skill
  it('includes test-writer skill reference in failure suggestions for missing tests', async () => {
    runTestSuiteCached.mockResolvedValue({
      passed: true,
      total: 0,
      passed_count: 0,
      failed: 0,
      skipped: 0,
      failedTests: [],
      rawOutput: '',
      metadata: {
        command: 'bun run vitest run --reporter=json -c vitest.config.ts --changed',
        cwd: 'C:/repo',
        timeoutMs: 120000,
        cacheKey: 'quality:C:/repo:tests:affected',
        cacheHit: false,
      },
    })

    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const result = await runner.runTestExecution('C:/repo', false, true, { enabled: false, knownFailingTests: [] }, 'affected')

    expect(result.passed).toBe(false)
    expect(result.suggestions.join(' ')).toContain('test-writer')
  })

  // Implements REQ-006, REQ-007: TDD enforcement catches impl-only diffs
  it('TDD enforcement fails for implementation-only feature diffs', async () => {
    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const implOnlyDiff = `
diff --git a/src/feature.ts b/src/feature.ts
new file mode 100644
+++ b/src/feature.ts
@@ -0,0 +1,10 @@
+export function newFeature() {
+  return 'hello';
+}
`

    const result = runner.enforceTestFirst(implOnlyDiff, {
      taskType: 'feature',
      tddPhase: 'review',
      taskDescription: 'Add new feature',
      workingDirectory: 'C:/repo',
    })

    expect(result).not.toBeNull()
    expect(result!.passed).toBe(false)
    expect(result!.issues.join(' ')).toContain('without test files')
  })

  // Implements REQ-009: TDD passes when both impl and test files present
  it('TDD enforcement passes for diffs with both impl and test files', async () => {
    const { QualityGateRunner } = await import('../quality-gate-runner')
    const runner = new QualityGateRunner({
      getMoonshotApiKey: async () => null,
      getAnthropicApiKey: async () => null,
      getOpenAiConfig: async () => null,
    })

    const bothDiff = `
diff --git a/src/feature.ts b/src/feature.ts
+++ b/src/feature.ts
+export function newFeature() { return 'hello'; }
diff --git a/src/__tests__/feature.test.ts b/src/__tests__/feature.test.ts
+++ b/src/__tests__/feature.test.ts
+import { newFeature } from '../feature';
+test('works', () => { expect(newFeature()).toBe('hello'); });
`

    const result = runner.enforceTestFirst(bothDiff, {
      taskType: 'feature',
      tddPhase: 'implementing',
      taskDescription: 'Add new feature',
      workingDirectory: 'C:/repo',
    })

    expect(result).not.toBeNull()
    expect(result!.passed).toBe(true)
  })
})
