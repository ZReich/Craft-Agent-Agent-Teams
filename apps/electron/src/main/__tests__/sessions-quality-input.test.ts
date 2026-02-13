import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}))

vi.mock('@sentry/electron/main', () => ({
  init: () => undefined,
  captureException: () => undefined,
}))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => Promise.resolve({ messages: [] }),
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
  AbortError: class AbortError extends Error {},
}))

import { resolveQualityGateReviewInput } from '../sessions'

describe('resolveQualityGateReviewInput', () => {
  it('uses git unified diff when present', () => {
    const result = resolveQualityGateReviewInput({
      unifiedDiff: 'diff --git a/a.ts b/a.ts\n+const x = 1\n',
    })

    expect(result.usesGitDiff).toBe(true)
    expect(result.reviewInput).toContain('diff --git')
    expect(result.failureReason).toBeUndefined()
  })

  it('fails closed when diff is missing', () => {
    const result = resolveQualityGateReviewInput(null)

    expect(result.usesGitDiff).toBe(false)
    expect(result.reviewInput).toBe('')
    expect(result.failureReason).toContain('No verifiable git diff')
  })

  it('fails closed when diff is empty/whitespace', () => {
    const result = resolveQualityGateReviewInput({
      unifiedDiff: '   \n  ',
    })

    expect(result.usesGitDiff).toBe(false)
    expect(result.reviewInput).toBe('')
    expect(result.failureReason).toContain('cannot rely on assistant prose')
  })
})
