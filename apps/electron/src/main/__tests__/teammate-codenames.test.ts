/**
 * Tests for teammate and team codename generation utilities.
 *
 * Tests the buildTeammateCodename, buildTeamCodename, and teammateMatchesTargetName
 * functions used for agent teams naming.
 */
import { describe, it, expect } from 'bun:test'
import {
  buildTeammateCodename,
  buildTeamCodename,
  teammateMatchesTargetName,
  isLeadTargetName,
  roleLabel,
  CODENAME_ADJECTIVES,
  CODENAME_NOUNS,
  ORCHESTRATOR_NAMES,
  HEAD_NAMES,
  WORKER_NAMES,
  REVIEWER_NAMES,
  ESCALATION_NAMES,
  TEAM_NAME_POOL,
} from '../teammate-codenames'

// ============================================================================
// roleLabel — Team role display labels
// ============================================================================

describe('roleLabel', () => {
  it('returns "Team Manager" for head role', () => {
    expect(roleLabel('head')).toBe('Team Manager')
  })

  it('returns "Orchestrator" for lead role', () => {
    expect(roleLabel('lead')).toBe('Orchestrator')
  })

  it('returns "Orchestrator" for orchestrator role', () => {
    expect(roleLabel('orchestrator')).toBe('Orchestrator')
  })

  it('returns "Team Manager" for team-manager role', () => {
    expect(roleLabel('team-manager')).toBe('Team Manager')
  })

  it('returns "Worker" for worker role', () => {
    expect(roleLabel('worker')).toBe('Worker')
  })

  it('returns "Reviewer" for reviewer role', () => {
    expect(roleLabel('reviewer')).toBe('Reviewer')
  })

  it('returns "Escalation" for escalation role', () => {
    expect(roleLabel('escalation')).toBe('Escalation')
  })
})

// ============================================================================
// buildTeammateCodename — Role-specific teammate name generation
// ============================================================================

describe('buildTeammateCodename', () => {
  const SEED = 'test-team'

  describe('role-specific pools', () => {
    it('generates worker name from WORKER_NAMES pool', () => {
      const name = buildTeammateCodename('worker', SEED, 0)
      expect(WORKER_NAMES).toContain(name)
    })

    it('generates lead name from ORCHESTRATOR_NAMES pool', () => {
      const name = buildTeammateCodename('lead', SEED, 0)
      expect(ORCHESTRATOR_NAMES).toContain(name)
    })

    it('generates orchestrator name from ORCHESTRATOR_NAMES pool', () => {
      const name = buildTeammateCodename('orchestrator', SEED, 0)
      expect(ORCHESTRATOR_NAMES).toContain(name)
    })

    it('generates head name from HEAD_NAMES pool', () => {
      const name = buildTeammateCodename('head', SEED, 0)
      expect(HEAD_NAMES).toContain(name)
    })

    it('generates team-manager name from HEAD_NAMES pool', () => {
      const name = buildTeammateCodename('team-manager', SEED, 0)
      expect(HEAD_NAMES).toContain(name)
    })

    it('generates reviewer name from REVIEWER_NAMES pool', () => {
      const name = buildTeammateCodename('reviewer', SEED, 0)
      expect(REVIEWER_NAMES).toContain(name)
    })

    it('generates escalation name from ESCALATION_NAMES pool', () => {
      const name = buildTeammateCodename('escalation', SEED, 0)
      expect(ESCALATION_NAMES).toContain(name)
    })

    it('different roles produce different names for same index', () => {
      const worker = buildTeammateCodename('worker', SEED, 0)
      const reviewer = buildTeammateCodename('reviewer', SEED, 0)
      const lead = buildTeammateCodename('lead', SEED, 0)
      // Names come from different pools, so at least some should differ
      const unique = new Set([worker, reviewer, lead])
      expect(unique.size).toBeGreaterThan(1)
    })
  })

  describe('determinism and team variation', () => {
    it('same team + same role + same index = same name', () => {
      expect(buildTeammateCodename('worker', 'alpha', 0)).toBe(buildTeammateCodename('worker', 'alpha', 0))
      expect(buildTeammateCodename('worker', 'alpha', 3)).toBe(buildTeammateCodename('worker', 'alpha', 3))
    })

    it('different teams produce different names', () => {
      const name1 = buildTeammateCodename('worker', 'team-alpha', 0)
      const name2 = buildTeammateCodename('worker', 'team-beta', 0)
      // Different team seeds should (with high probability) produce different names
      // Not guaranteed for all seeds, but very likely for these
      expect(name1).not.toBe(name2)
    })

    it('orchestrator at index 0 stays consistent within a team', () => {
      const name1 = buildTeammateCodename('lead', 'my-project', 0)
      const name2 = buildTeammateCodename('lead', 'my-project', 0)
      expect(name1).toBe(name2)
    })

    it('different indices produce different names within same team', () => {
      const name1 = buildTeammateCodename('worker', SEED, 0)
      const name2 = buildTeammateCodename('worker', SEED, 1)
      expect(name1).not.toBe(name2)
    })
  })

  describe('cycling behavior', () => {
    it('cycles through worker pool', () => {
      const names = new Set<string>()
      for (let i = 0; i < WORKER_NAMES.length; i++) {
        names.add(buildTeammateCodename('worker', SEED, i))
      }
      expect(names.size).toBe(WORKER_NAMES.length)
    })

    it('wraps around after exhausting pool', () => {
      const first = buildTeammateCodename('worker', SEED, 0)
      const wrapped = buildTeammateCodename('worker', SEED, WORKER_NAMES.length)
      expect(first).toBe(wrapped)
    })
  })

  describe('edge cases', () => {
    it('handles index 0', () => {
      const name = buildTeammateCodename('worker', SEED, 0)
      expect(name).toBeTruthy()
      expect(WORKER_NAMES).toContain(name)
    })

    it('handles large indices', () => {
      const name = buildTeammateCodename('worker', SEED, 999)
      expect(name).toBeTruthy()
      expect(WORKER_NAMES).toContain(name)
    })

    it('handles empty team seed', () => {
      const name = buildTeammateCodename('worker', '', 0)
      expect(name).toBeTruthy()
      expect(WORKER_NAMES).toContain(name)
    })
  })
})

// ============================================================================
// buildTeamCodename — Team name generation
// ============================================================================

describe('buildTeamCodename', () => {
  describe('basic generation', () => {
    it('generates team name from seed', () => {
      const name = buildTeamCodename('my-team')
      expect(TEAM_NAME_POOL).toContain(name)
    })

    it('generates consistent names for same seed', () => {
      expect(buildTeamCodename('alpha')).toBe(buildTeamCodename('alpha'))
      expect(buildTeamCodename('beta')).toBe(buildTeamCodename('beta'))
    })

    it('generates different names for different seeds', () => {
      // Not guaranteed, but highly likely for these seeds
      expect(buildTeamCodename('alpha')).not.toBe(buildTeamCodename('beta'))
    })

    it('uses operation/mission themed names', () => {
      const name = buildTeamCodename('test')
      expect(TEAM_NAME_POOL).toContain(name)
    })
  })

  describe('deterministic hashing', () => {
    it('is case-insensitive', () => {
      expect(buildTeamCodename('MyTeam')).toBe(buildTeamCodename('myteam'))
      expect(buildTeamCodename('ALPHA')).toBe(buildTeamCodename('alpha'))
    })

    it('ignores leading/trailing whitespace', () => {
      expect(buildTeamCodename('  team  ')).toBe(buildTeamCodename('team'))
    })
  })

  describe('edge cases', () => {
    it('handles empty string', () => {
      const name = buildTeamCodename('')
      expect(name).toBeTruthy()
      expect(TEAM_NAME_POOL).toContain(name)
    })

    it('handles single character', () => {
      const name = buildTeamCodename('a')
      expect(name).toBeTruthy()
      expect(TEAM_NAME_POOL).toContain(name)
    })

    it('handles special characters', () => {
      const name = buildTeamCodename('team-123!@#')
      expect(name).toBeTruthy()
      expect(TEAM_NAME_POOL).toContain(name)
    })

    it('handles unicode characters', () => {
      const name = buildTeamCodename('チーム')
      expect(name).toBeTruthy()
      expect(TEAM_NAME_POOL).toContain(name)
    })
  })
})

// ============================================================================
// Backward compatibility — deprecated exports still work
// ============================================================================

describe('deprecated exports', () => {
  it('CODENAME_ADJECTIVES is still exported', () => {
    expect(CODENAME_ADJECTIVES).toHaveLength(10)
  })

  it('CODENAME_NOUNS is still exported', () => {
    expect(CODENAME_NOUNS).toHaveLength(10)
  })
})

// ============================================================================
// teammateMatchesTargetName — Name matching logic
// ============================================================================

describe('teammateMatchesTargetName', () => {
  describe('exact matches', () => {
    it('matches exact teammateName', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, 'Pixel Wrench')).toBe(true)
    })

    it('matches exact sessionName', () => {
      expect(teammateMatchesTargetName(undefined, 'worker-123', 'worker-123')).toBe(true)
    })

    it('is case-insensitive for exact matches', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, 'pixel wrench')).toBe(true)
    })

    it('ignores leading/trailing whitespace', () => {
      expect(teammateMatchesTargetName('worker-1', undefined, '  worker-1  ')).toBe(true)
    })
  })

  describe('parentheses matching', () => {
    it('matches name inside parentheses', () => {
      expect(teammateMatchesTargetName('Pixel Wrench (custom-name)', undefined, 'custom-name')).toBe(true)
    })

    it('matches name inside brackets', () => {
      expect(teammateMatchesTargetName('Pixel Wrench [custom-name]', undefined, 'custom-name')).toBe(true)
    })
  })

  describe('word boundary matching', () => {
    it('matches word at start', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, 'Pixel')).toBe(true)
    })

    it('matches word at end', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, 'Wrench')).toBe(true)
    })

    it('does not match partial word', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, 'Wren')).toBe(false)
    })

    it('handles hyphens as word boundaries', () => {
      expect(teammateMatchesTargetName('worker-pixel-wrench', undefined, 'pixel')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('returns false for empty target', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, '')).toBe(false)
    })

    it('returns false for whitespace-only target', () => {
      expect(teammateMatchesTargetName('Pixel Wrench', undefined, '   ')).toBe(false)
    })

    it('handles undefined teammateName', () => {
      expect(teammateMatchesTargetName(undefined, 'session-1', 'session-1')).toBe(true)
    })

    it('handles both undefined', () => {
      expect(teammateMatchesTargetName(undefined, undefined, 'anything')).toBe(false)
    })
  })

  describe('real-world scenarios', () => {
    it('matches codename from full display name', () => {
      const displayName = 'Byte Hammer (teammate-1771022940414)'
      expect(teammateMatchesTargetName(displayName, undefined, 'Byte')).toBe(true)
      expect(teammateMatchesTargetName(displayName, undefined, 'Hammer')).toBe(true)
      expect(teammateMatchesTargetName(displayName, undefined, 'teammate-1771022940414')).toBe(true)
    })

    it('matches @team suffix aliases to local teammate names', () => {
      expect(teammateMatchesTargetName('taco-champion', undefined, 'taco-champion@food-debate')).toBe(true)
      expect(teammateMatchesTargetName('pizza_champion', undefined, 'pizza-champion@food-debate')).toBe(true)
    })

    it('matches normalized separator variants', () => {
      expect(teammateMatchesTargetName('team_lead_food_debate', undefined, 'team-lead-food-debate')).toBe(true)
      expect(teammateMatchesTargetName('worker-pixel-wrench', undefined, 'worker_pixel_wrench')).toBe(true)
    })
  })
})

// ============================================================================
// isLeadTargetName — Canonical lead alias detection
// ============================================================================

describe('isLeadTargetName', () => {
  it('matches canonical lead aliases', () => {
    expect(isLeadTargetName('lead')).toBe(true)
    expect(isLeadTargetName('team-lead')).toBe(true)
    expect(isLeadTargetName('team_lead')).toBe(true)
  })

  it('matches lead aliases with @team suffix', () => {
    expect(isLeadTargetName('team-lead@food-debate')).toBe(true)
    expect(isLeadTargetName('lead@food-debate')).toBe(true)
  })

  it('matches expanded lead aliases containing team name', () => {
    expect(isLeadTargetName('team_lead_food_debate', 'food-debate')).toBe(true)
    expect(isLeadTargetName('lead_food_debate', 'food-debate')).toBe(true)
  })

  it('does not match worker aliases', () => {
    expect(isLeadTargetName('taco-champion')).toBe(false)
    expect(isLeadTargetName('pizza-champion@food-debate')).toBe(false)
  })
})
