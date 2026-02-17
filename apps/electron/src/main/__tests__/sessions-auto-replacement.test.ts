import { describe, expect, it, vi } from 'vitest'

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

import { buildAutoReplacementAttemptKey, buildAutoReplacementPrompt } from '../sessions'

describe('buildAutoReplacementAttemptKey', () => {
  it('normalizes task description into stable lowercase key', () => {
    const key = buildAutoReplacementAttemptKey({
      taskDescription: '  Research Best Restaurants in Billings  ',
      teammateRole: 'worker',
      teammateName: 'worker-1',
    })

    expect(key).toBe('research best restaurants in billings')
  })

  it('falls back to role/name when task text is absent', () => {
    const key = buildAutoReplacementAttemptKey({
      teammateRole: 'worker',
      teammateName: 'worker-1',
    })

    expect(key).toBe('worker:worker-1')
  })
})

describe('buildAutoReplacementPrompt', () => {
  it('embeds original prompt and recovered partial findings', () => {
    const prompt = buildAutoReplacementPrompt({
      originalPrompt: 'Find top 3 options with citations.',
      teammateName: 'worker-1',
      failureReason: 'retry-storm kill',
      partialResults: ['- **WebSearch**: Found Tripadvisor snapshot'],
      attempt: 1,
    })

    expect(prompt).toContain('Find top 3 options with citations.')
    expect(prompt).toContain('auto-replacement attempt #1')
    expect(prompt).toContain('Recovered partial findings:')
    expect(prompt).toContain('Found Tripadvisor snapshot')
    expect(prompt).toContain('Send a direct completion handoff to team-lead')
  })
})
