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
})
