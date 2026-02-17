import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentTeamManager } from '../agent-team-manager'
import { clearAllTeamKnowledgeBuses } from '../../agent-teams/team-knowledge-bus-registry'

function createManagerWithTeam(workspaceRootPath: string) {
  const manager = new AgentTeamManager()
  const team = manager.createTeam({
    name: 'knowledge-loop',
    leadSessionId: 'lead-session',
    workspaceRootPath,
    modelConfig: {
      defaults: {
        lead: { model: 'test', provider: 'test' },
        head: { model: 'test', provider: 'test' },
        worker: { model: 'test', provider: 'test' },
        reviewer: { model: 'test', provider: 'test' },
        escalation: { model: 'test', provider: 'test' },
      },
    },
  })
  return { manager, team }
}

describe('AgentTeamManager knowledge loop', () => {
  it('supports publish -> persist -> hydrate -> query -> prompt context flow', () => {
    clearAllTeamKnowledgeBuses()
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-team-knowledge-loop-'))
    const { manager, team } = createManagerWithTeam(workspaceRoot)

    manager.publishKnowledge(team.id, {
      type: 'pattern',
      content: 'Auth service rotates refresh tokens and enforces JWT expiry checks',
      source: 'worker-auth',
      filePaths: ['src/auth/service.ts'],
      tags: ['auth', 'jwt', 'refresh-token'],
    })

    const initialContext = manager.buildKnowledgeContext(
      team.id,
      'Update src/auth/service.ts to preserve refresh token rotation',
      { maxEntries: 6, maxChars: 1200, maxTokens: 300 },
    )
    expect(initialContext).toContain('Team Knowledge Bus Context')
    expect(initialContext).toContain('refresh tokens')

    const persisted = manager.loadPersistedState(team.id)
    expect(persisted).not.toBeNull()
    expect((persisted?.knowledge ?? []).length).toBeGreaterThan(0)

    const manager2 = new AgentTeamManager()
    const sessionDir = join(workspaceRoot, 'sessions', 'lead-session')
    manager2.initStateStore(team.id, sessionDir)
    for (const entry of persisted?.knowledge ?? []) {
      manager2.hydrateKnowledgeEntry(team.id, entry)
    }

    const byFile = manager2.queryKnowledgeByFile(team.id, 'src/auth/service.ts')
    expect(byFile.length).toBeGreaterThan(0)

    const byText = manager2.queryKnowledgeText(team.id, 'refresh token jwt expiry', 5)
    expect(byText.length).toBeGreaterThan(0)

    const hydratedContext = manager2.buildKnowledgeContext(
      team.id,
      'Review auth token handling in src/auth/service.ts',
      { maxEntries: 6, maxChars: 1200, maxTokens: 300 },
    )
    expect(hydratedContext).toContain('Team Knowledge Bus Context')
    expect(hydratedContext).toContain('Auth service rotates refresh tokens')

    clearAllTeamKnowledgeBuses()
  })
})


