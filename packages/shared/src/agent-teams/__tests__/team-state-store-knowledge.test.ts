import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { TeamStateStore } from '../team-state-store'
import type { KnowledgeEntry } from '../team-knowledge-bus'

describe('TeamStateStore knowledge persistence (REQ-NEXT-001)', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0, cleanupDirs.length)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup failures in tests
      }
    }
  })

  it('persists and reloads knowledge entries via jsonl', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'team-state-kb-'))
    cleanupDirs.push(sessionDir)
    const store = new TeamStateStore(sessionDir)

    const now = Date.now()
    const entry: KnowledgeEntry = {
      id: 'kb-test-1',
      type: 'pattern',
      content: 'AuthService uses JWT + refresh tokens',
      source: 'worker-a',
      filePaths: ['src/auth/service.ts'],
      tags: ['auth', 'jwt'],
      timestamp: now,
    }

    store.appendKnowledge(entry)
    const state = store.load()

    expect(state.knowledge).toHaveLength(1)
    expect(state.knowledge[0]?.id).toBe('kb-test-1')
    expect(state.knowledge[0]?.tags).toContain('jwt')
  })
})

