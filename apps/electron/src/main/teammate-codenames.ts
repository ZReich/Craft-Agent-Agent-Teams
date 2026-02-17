/**
 * Teammate and team codename generation utilities.
 * Extracted to a separate file to allow unit testing without importing
 * Electron main process modules.
 */

import type { TeamRole } from '@craft-agent/core/types'

// ============================================================================
// Role-Specific Name Pools (REQ-P5)
// ============================================================================

// Implements REQ-P5: Role-flavored witty codenames, randomized per team

/** Orchestrator/Lead names — authoritative, strategic */
const ORCHESTRATOR_NAMES = [
  'Admiral Blueprint', 'General Oversight', 'Captain Mandate',
  'Commander Horizon', 'Architect Prime', 'Director Nexus',
  'Chancellor Schema', 'Marshal Accord', 'Sovereign Apex',
  'Consul Keystone', 'Warden Pinnacle', 'Viceroy Compass',
]

/** Head/Manager names — domain-expert coordinators */
const HEAD_NAMES = [
  'Quartermaster Stack', 'Foreman Pipeline', 'Chief Scaffold',
  'Steward Module', 'Overseer Branch', 'Conductor Sprint',
  'Warden Merge', 'Dispatch Vector', 'Harbinger Deploy',
  'Prefect Cache', 'Curator Schema', 'Ranger Upstream',
]

/** Worker names — hands-on builders, witty crafters */
const WORKER_NAMES = [
  'Pixel Wrench', 'Byte Hammer', 'Logic Chisel', 'Syntax Anvil',
  'Cache Welder', 'Thread Splicer', 'Node Riveter', 'Stack Mason',
  'Query Smith', 'Buffer Lathe', 'Render Forge', 'Parse Cutter',
  'Flux Tinker', 'Schema Joiner', 'Token Bender', 'Queue Plumber',
  'Patch Crafter', 'Route Fitter', 'Hook Winder', 'State Miller',
]

/** Reviewer names — sharp-eyed inspectors */
const REVIEWER_NAMES = [
  'Inspector Lint', 'Auditor Scope', 'Judge Coverage',
  'Sentinel Diff', 'Watcher Assert', 'Critic Trace',
  'Arbiter Check', 'Oracle Verify', 'Proctor Gate',
  'Examiner Bound', 'Assessor Scan', 'Censor Proof',
]

/** Escalation names — heavy-hitters for tough problems */
const ESCALATION_NAMES = [
  'Doctor Hotfix', 'Surgeon Patch', 'Fixer Absolute',
  'Specialist Override', 'Medic Restore', 'Expert Salvage',
  'Resolver Prime', 'Breaker Debug', 'Savant Recovery',
  'Ace Failsafe', 'Guru Rollback', 'Maven Triage',
]

/** Team names — operation/mission themed */
const TEAM_NAME_POOL = [
  'Operation Keystone', 'Project Vanguard', 'Task Force Apex',
  'Squadron Nimbus', 'Division Prism', 'Unit Meridian',
  'Campaign Zenith', 'Initiative Flux', 'Collective Cipher',
  'Alliance Vertex', 'Corps Helix', 'Platoon Drift',
]

// ============================================================================
// Deprecated Word Lists (backward compatibility)
// ============================================================================

/** @deprecated Use role-specific name pools instead */
export const CODENAME_ADJECTIVES = ['Neon', 'Shadow', 'Solar', 'Arctic', 'Crimson', 'Ivory', 'Titan', 'Delta', 'Nova', 'Obsidian']
/** @deprecated Use role-specific name pools instead */
export const CODENAME_NOUNS = ['Falcon', 'Viper', 'Comet', 'Sentinel', 'Raven', 'Pioneer', 'Circuit', 'Phoenix', 'Atlas', 'Cipher']

// ============================================================================
// Role-to-Pool Mapping
// ============================================================================

const ROLE_NAME_POOLS: Record<string, string[]> = {
  lead: ORCHESTRATOR_NAMES,
  orchestrator: ORCHESTRATOR_NAMES,
  head: HEAD_NAMES,
  'team-manager': HEAD_NAMES,
  worker: WORKER_NAMES,
  reviewer: REVIEWER_NAMES,
  escalation: ESCALATION_NAMES,
}

function normalizeRoleForNames(role: TeamRole): string {
  if (role === 'orchestrator') return 'lead'
  if (role === 'team-manager') return 'head'
  return role
}

/** Simple string hash for deterministic but varied name selection per team */
function hashSeed(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    const ch = seed.charCodeAt(i)
    hash = ((hash << 5) - hash) + ch
    hash |= 0 // Convert to 32-bit int
  }
  return Math.abs(hash)
}

// ============================================================================
// Exported Name Pools
// ============================================================================

export {
  ORCHESTRATOR_NAMES,
  HEAD_NAMES,
  WORKER_NAMES,
  REVIEWER_NAMES,
  ESCALATION_NAMES,
  TEAM_NAME_POOL,
}

// ============================================================================
// Role Label Mapping
// ============================================================================

/**
 * Get the display label for a team role.
 */
export function roleLabel(role: TeamRole): string {
  const labels: Record<string, string> = {
    lead: 'Orchestrator',
    orchestrator: 'Orchestrator',
    head: 'Team Manager',
    'team-manager': 'Team Manager',
    worker: 'Worker',
    reviewer: 'Reviewer',
    escalation: 'Escalation',
  }
  return labels[role] ?? 'Worker'
}

// ============================================================================
// Codename Generation
// ============================================================================

/**
 * Build a unique codename for a teammate based on role, team, and index.
 *
 * Names are drawn from role-specific themed pools and offset by
 * a team hash so different teams get different name assignments.
 *
 * - Same team + same role + same index = same name (deterministic)
 * - Different team = different offset into the pool
 * - Orchestrator at index 0 stays consistent within a team across sessions
 */
export function buildTeammateCodename(role: TeamRole, teamSeed: string, index: number): string {
  const normalizedRole = normalizeRoleForNames(role)
  const pool = ROLE_NAME_POOLS[normalizedRole] ?? WORKER_NAMES
  const teamOffset = hashSeed(teamSeed)
  return pool[(teamOffset + index) % pool.length]
}

/**
 * Build a team codename based on a seed string.
 * Uses mission/operation themed names instead of adjective+noun.
 */
export function buildTeamCodename(seed: string): string {
  const hash = hashSeed(seed.trim().toLowerCase())
  return TEAM_NAME_POOL[hash % TEAM_NAME_POOL.length]
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
