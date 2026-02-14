/**
 * Teammate and team codename generation utilities.
 * Extracted to a separate file to allow unit testing without importing
 * Electron main process modules.
 */

import type { TeamRole } from '@craft-agent/core/types'

// ============================================================================
// Codename Word Lists
// ============================================================================

export const CODENAME_ADJECTIVES = [
  'Neon', 'Shadow', 'Solar', 'Arctic', 'Crimson', 'Ivory', 'Titan', 'Delta', 'Nova', 'Obsidian',
]

export const CODENAME_NOUNS = [
  'Falcon', 'Viper', 'Comet', 'Sentinel', 'Raven', 'Pioneer', 'Circuit', 'Phoenix', 'Atlas', 'Cipher',
]

// ============================================================================
// Role Label Mapping
// ============================================================================

/**
 * Get the display label for a team role.
 */
export function roleLabel(role: TeamRole): string {
  if (role === 'reviewer') return 'Reviewer'
  if (role === 'escalation') return 'Escalation'
  if (role === 'head') return 'Head'
  if (role === 'lead') return 'Lead'
  return 'Worker'
}

// ============================================================================
// Codename Generation
// ============================================================================

/**
 * Build a unique codename for a teammate based on index.
 *
 * Generates names like "Neon Falcon", "Shadow Viper", etc.
 * Role is displayed separately in the UI, not embedded in the name.
 * - Adjective cycles based on index % 10
 * - Noun cycles based on floor(index / 10) % 10
 * - Creates 100 unique combinations
 *
 * @example
 * buildTeammateCodename('worker', 0) // "Neon Falcon"
 * buildTeammateCodename('worker', 1) // "Shadow Falcon"
 * buildTeammateCodename('head', 10) // "Neon Viper"
 */
export function buildTeammateCodename(role: TeamRole, index: number): string {
  const adjective = CODENAME_ADJECTIVES[index % CODENAME_ADJECTIVES.length]
  const noun = CODENAME_NOUNS[(Math.floor(index / CODENAME_ADJECTIVES.length)) % CODENAME_NOUNS.length]
  return `${adjective} ${noun}`
}

/**
 * Build a team codename based on a seed string.
 *
 * Generates team names like "Neon Falcon Squad", "Crimson Viper Squad", etc.
 * Uses a simple character code hash to deterministically select adjective and noun.
 *
 * @example
 * buildTeamCodename('my-team') // "Neon Falcon Squad"
 * buildTeamCodename('another') // "Arctic Viper Squad"
 */
export function buildTeamCodename(seed: string): string {
  const normalized = seed.trim().toLowerCase()
  const hash = Array.from(normalized).reduce((acc, ch) => acc + ch.charCodeAt(0), 0)
  const adjective = CODENAME_ADJECTIVES[hash % CODENAME_ADJECTIVES.length]
  const noun = CODENAME_NOUNS[Math.floor(hash / CODENAME_ADJECTIVES.length) % CODENAME_NOUNS.length]
  return `${adjective} ${noun} Squad`
}

// ============================================================================
// Name Matching
// ============================================================================

/**
 * Check if a teammate matches a target name.
 *
 * Supports multiple matching strategies:
 * 1. Exact match on teammateName or sessionName (case-insensitive)
 * 2. Match inside parentheses: "Worker Neon Falcon (custom-name)"
 * 3. Word boundary match for partial names
 *
 * @example
 * teammateMatchesTargetName('Worker Neon Falcon (worker-1)', undefined, 'worker-1') // true
 * teammateMatchesTargetName('Worker Neon Falcon', undefined, 'neon') // true
 * teammateMatchesTargetName('Worker Neon Falcon', undefined, 'worker') // true
 */
export function teammateMatchesTargetName(
  teammateName: string | undefined,
  sessionName: string | undefined,
  targetName: string
): boolean {
  const rawTarget = targetName.trim().toLowerCase()
  if (!rawTarget) return false

  const teammate = teammateName?.trim().toLowerCase() ?? ''
  const session = sessionName?.trim().toLowerCase() ?? ''

  const normalizedKey = (value: string): string =>
    value
      .toLowerCase()
      .replace(/@[^\\s]+$/g, '') // drop @team suffix for alias matching
      .replace(/[^a-z0-9]+/g, '')

  const targetCandidates = new Set<string>([
    rawTarget,
    rawTarget.replace(/^@+/, ''),
  ])

  // If target includes team suffix (e.g. worker@team), also match local part.
  if (rawTarget.includes('@')) {
    targetCandidates.add(rawTarget.split('@')[0] ?? rawTarget)
  }

  const teammateCandidates = [teammate, session].filter(Boolean)

  for (const target of targetCandidates) {
    const trimmedTarget = target.trim()
    if (!trimmedTarget) continue

    // Exact match on either field
    if (teammateCandidates.some(candidate => candidate === trimmedTarget)) return true

    // Normalized exact match (handles -, _, spaces, and @team suffix variance)
    const normalizedTarget = normalizedKey(trimmedTarget)
    if (normalizedTarget && teammateCandidates.some(candidate => normalizedKey(candidate) === normalizedTarget)) {
      return true
    }

    // Match inside parentheses or brackets: "Worker Neon Falcon (custom-name)"
    if (teammate.includes(`(${trimmedTarget})`) || teammate.includes(`[${trimmedTarget}]`)) return true

    // Word boundary regex match
    const escaped = trimmedTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const boundary = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, 'i')
    if (boundary.test(teammate) || boundary.test(session)) return true
  }

  return false
}

/**
 * Detect whether a SendMessage target should resolve to the team lead.
 *
 * Implements REQ-001/REQ-002: normalize lead recipient aliases so workers can
 * reliably deliver results without retry storms due to naming variants.
 */
export function isLeadTargetName(targetName: string, teamName?: string): boolean {
  const raw = targetName.trim().toLowerCase()
  if (!raw) return false

  const local = raw.includes('@') ? (raw.split('@')[0] ?? raw) : raw
  const normalized = local.replace(/[^a-z0-9]+/g, '')

  if (normalized === 'lead' || normalized === 'teamlead' || normalized === 'orchestratorlead') {
    return true
  }

  // Handle variants like team_lead_food_debate / team-lead-food-debate.
  if (normalized.startsWith('teamlead')) {
    return true
  }

  if (!teamName) return false

  const teamNorm = teamName.toLowerCase().replace(/[^a-z0-9]+/g, '')
  if (!teamNorm) return false

  // Handle local targets like "leadfooddebate" or "teamleadfooddebate".
  return normalized === `lead${teamNorm}` || normalized === `teamlead${teamNorm}`
}
