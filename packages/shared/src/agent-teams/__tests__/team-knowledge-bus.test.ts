import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamKnowledgeBus } from '../team-knowledge-bus'
import {
  buildKnowledgeInjectionBlock,
  clearAllTeamKnowledgeBuses,
  getOrCreateTeamKnowledgeBus,
} from '../team-knowledge-bus-registry'

describe('TeamKnowledgeBus (REQ-NEXT-001)', () => {
  beforeEach(() => {
    clearAllTeamKnowledgeBuses()
  })

  afterEach(() => {
    vi.useRealTimers()
    clearAllTeamKnowledgeBuses()
  })

  it('publishes and queries by tags and file paths', () => {
    const bus = new TeamKnowledgeBus('team-1')
    bus.publish({
      type: 'pattern',
      content: 'AuthService uses JWT + refresh tokens',
      source: 'worker-a',
      filePaths: ['src/auth/service.ts'],
      tags: ['auth', 'jwt'],
    })

    const byTag = bus.query(['jwt'])
    expect(byTag).toHaveLength(1)
    expect(byTag[0]?.type).toBe('pattern')

    const byFile = bus.queryByFile('src/auth/service.ts')
    expect(byFile).toHaveLength(1)
    expect(byFile[0]?.source).toBe('worker-a')
  })

  it('supports natural-language retrieval via content match', () => {
    const bus = new TeamKnowledgeBus('team-1')
    bus.publish({
      type: 'pattern',
      content: 'AuthService rotates refresh tokens and uses JWT access tokens',
      source: 'worker-a',
      filePaths: ['src/auth/service.ts'],
      tags: ['auth'],
    })
    bus.publish({
      type: 'discovery',
      content: 'Renderer modal keyboard shortcuts updated',
      source: 'worker-b',
      filePaths: ['src/ui/modal.tsx'],
      tags: ['ui'],
    })

    const matches = bus.queryText('refresh token strategy', 5)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.filePaths?.[0]).toContain('src/auth/service.ts')
  })

  it('expires ttl-bound entries during query', () => {
    vi.useFakeTimers()

    const bus = new TeamKnowledgeBus('team-1')
    bus.publish({
      type: 'discovery',
      content: 'temporary entry',
      source: 'worker-a',
      tags: ['tmp'],
      ttl: 1000,
    })

    expect(bus.query(['tmp']).length).toBe(1)
    vi.advanceTimersByTime(1500)
    expect(bus.query(['tmp']).length).toBe(0)
  })

  it('detects overlapping file edits within 30s and records conflicts', () => {
    const bus = new TeamKnowledgeBus('team-1')
    const first = bus.recordFileEdit({
      filePath: 'src/api/routes.ts',
      teammateId: 'mate-a',
      teammateName: 'Worker A',
    })
    expect(first.conflict).toBeNull()

    const second = bus.recordFileEdit({
      filePath: 'src/api/routes.ts',
      teammateId: 'mate-b',
      teammateName: 'Worker B',
    })
    expect(second.conflict).toBeTruthy()
    expect(second.warningEntry?.type).toBe('warning')

    const conflicts = bus.getConflicts('src/api/routes.ts')
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]?.editors.map((editor) => editor.teammateId)).toContain('mate-a')
    expect(conflicts[0]?.editors.map((editor) => editor.teammateId)).toContain('mate-b')
  })

  it('builds bounded prompt context for memory injection', () => {
    const bus = getOrCreateTeamKnowledgeBus('team-1')
    for (let i = 0; i < 20; i++) {
      bus.publish({
        type: 'discovery',
        content: `Discovery ${i} about src/module-${i}.ts`,
        source: `worker-${i}`,
        filePaths: [`src/module-${i}.ts`],
        tags: ['module', `m${i}`],
      })
    }

    const block = buildKnowledgeInjectionBlock(
      'team-1',
      'Implement worker task for src/module-1.ts and module behavior',
      { maxChars: 500, maxEntries: 10 },
    )

    expect(block).toContain('Team Knowledge Bus Context')
    expect(block.length).toBeLessThanOrEqual(500)
  })

  it('enforces token budget guardrail for injected prompt context', () => {
    const bus = getOrCreateTeamKnowledgeBus('team-1')
    for (let i = 0; i < 10; i++) {
      bus.publish({
        type: 'pattern',
        content: `Long discovery ${i}: ${'x'.repeat(90)}`,
        source: `worker-${i}`,
        filePaths: [`src/domain/file-${i}.ts`],
        tags: ['domain', `topic-${i}`],
      })
    }

    const block = buildKnowledgeInjectionBlock(
      'team-1',
      'Implement worker task for src/domain/file-1.ts',
      { maxChars: 10_000, maxEntries: 10, maxTokens: 60 },
    )

    expect(block).toContain('Team Knowledge Bus Context')
    expect(Math.ceil(block.length / 4)).toBeLessThanOrEqual(60)
  })
})
