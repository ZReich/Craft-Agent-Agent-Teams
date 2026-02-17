import { TeamKnowledgeBus } from './team-knowledge-bus'

const TEAM_KNOWLEDGE_BUSES = new Map<string, TeamKnowledgeBus>()

export function getOrCreateTeamKnowledgeBus(teamId: string): TeamKnowledgeBus {
  if (!TEAM_KNOWLEDGE_BUSES.has(teamId)) {
    TEAM_KNOWLEDGE_BUSES.set(teamId, new TeamKnowledgeBus(teamId))
  }
  return TEAM_KNOWLEDGE_BUSES.get(teamId)!
}

export function getTeamKnowledgeBus(teamId: string): TeamKnowledgeBus | null {
  return TEAM_KNOWLEDGE_BUSES.get(teamId) ?? null
}

export function clearTeamKnowledgeBus(teamId: string): void {
  const bus = TEAM_KNOWLEDGE_BUSES.get(teamId)
  if (!bus) return
  bus.clear()
  TEAM_KNOWLEDGE_BUSES.delete(teamId)
}

export function clearAllTeamKnowledgeBuses(): void {
  for (const [teamId, bus] of TEAM_KNOWLEDGE_BUSES.entries()) {
    bus.clear()
    TEAM_KNOWLEDGE_BUSES.delete(teamId)
  }
}

export function buildKnowledgeInjectionBlock(
  teamId: string,
  taskPrompt: string,
  options?: { maxChars?: number; maxEntries?: number; maxTokens?: number },
): string {
  const bus = TEAM_KNOWLEDGE_BUSES.get(teamId)
  if (!bus) return ''
  return bus.buildPromptContext(taskPrompt, options)
}
