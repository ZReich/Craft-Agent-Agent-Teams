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
  const target = targetName.trim().toLowerCase()
  if (!target) return false

  const teammate = teammateName?.trim().toLowerCase() ?? ''
  const session = sessionName?.trim().toLowerCase() ?? ''

  // Exact match on either field
  if (teammate === target || session === target) return true

  // Match inside parentheses or brackets: "Worker Neon Falcon (custom-name)"
  if (teammate.includes(`(${target})`) || teammate.includes(`[${target}]`)) return true

  // Word boundary regex match
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const boundary = new RegExp(`(?:^|\\W)${escaped}(?:\\W|$)`, 'i')
  return boundary.test(teammate)
}
