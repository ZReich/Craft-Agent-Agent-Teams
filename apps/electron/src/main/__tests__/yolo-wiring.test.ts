import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

function readSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), 'utf8')
}

describe('YOLO wiring regression coverage', () => {
  it('has active call sites for YOLO wiring and auto-start', () => {
    const ipcSource = readSource('src/main/ipc.ts')
    const sessionsSource = readSource('src/main/sessions.ts')

    expect(ipcSource).toContain('sessionManager.ensureYoloWiredForTeam(team.id, options.leadSessionId)')
    expect(sessionsSource).toContain('this.setupYoloOrchestrator(resolvedTeamId, leadSessionId, workingDirectory)')
    expect(sessionsSource).toContain('this.startYoloIfConfigured(managed, teamName)')
  })

  it('emits yolo_state_changed when orchestrator state changes', () => {
    const sessionsSource = readSource('src/main/sessions.ts')

    expect(sessionsSource).toContain("type: 'yolo_state_changed'")
    expect(sessionsSource).toContain('teamManager.updateYoloState(_teamId, state)')
  })

  it('declares yolo_state_changed in shared SessionEvent typing', () => {
    const sharedTypes = readSource('src/shared/types.ts')

    expect(sharedTypes).toContain("type: 'yolo_state_changed'")
    expect(sharedTypes).toContain("state: import('@craft-agent/core/types').YoloState")
  })
})
