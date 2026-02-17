import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { KNOWLEDGE_RETENTION_DAYS, TeamStateStore } from '../team-state-store'
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

  it('prunes expired/stale knowledge on load and rewrites compacted state (REQ-009)', () => {
    const sessionDir = mkdtempSync(join(tmpdir(), 'team-state-kb-retention-'))
    cleanupDirs.push(sessionDir)
    const store = new TeamStateStore(sessionDir)
    const now = Date.now()
    const staleEntry: KnowledgeEntry = {
      id: 'kb-stale',
      type: 'discovery',
      content: 'stale',
      source: 'worker-a',
      tags: ['stale'],
      timestamp: now - ((KNOWLEDGE_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000),
    }
    const freshEntry: KnowledgeEntry = {
      id: 'kb-fresh',
      type: 'discovery',
      content: 'fresh',
      source: 'worker-b',
      tags: ['fresh'],
      timestamp: now,
    }

    store.appendKnowledge(staleEntry)
    store.appendKnowledge(freshEntry)

    const state = store.load()
    expect(state.knowledge).toHaveLength(1)
    expect(state.knowledge[0]?.id).toBe('kb-fresh')

    const persisted = readFileSync(join(sessionDir, 'team-state.jsonl'), 'utf-8')
    expect(persisted).toContain('kb-fresh')
    expect(persisted).not.toContain('kb-stale')
  })
})
