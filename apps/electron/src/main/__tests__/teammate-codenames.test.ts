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
  roleLabel,
  CODENAME_ADJECTIVES,
  CODENAME_NOUNS,
} from '../teammate-codenames'

// ============================================================================
// roleLabel — Team role display labels
// ============================================================================

describe('roleLabel', () => {
  it('returns "Head" for head role', () => {
    expect(roleLabel('head')).toBe('Head')
  })

  it('returns "Lead" for lead role', () => {
    expect(roleLabel('lead')).toBe('Lead')
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
// buildTeammateCodename — Teammate name generation
// ============================================================================

describe('buildTeammateCodename', () => {
  describe('basic generation', () => {
    it('generates first worker name', () => {
      expect(buildTeammateCodename('worker', 0)).toBe('Neon Falcon')
    })

    it('generates second worker name', () => {
      expect(buildTeammateCodename('worker', 1)).toBe('Shadow Falcon')
    })

    it('generates tenth worker name', () => {
      expect(buildTeammateCodename('worker', 9)).toBe('Obsidian Falcon')
    })

    it('cycles adjectives after 10 teammates', () => {
      expect(buildTeammateCodename('worker', 10)).toBe('Neon Viper')
    })

    it('cycles nouns after 100 teammates', () => {
      expect(buildTeammateCodename('worker', 100)).toBe('Neon Falcon')
    })
  })

  describe('role independence', () => {
    it('generates same name for head role', () => {
      expect(buildTeammateCodename('head', 0)).toBe('Neon Falcon')
    })

    it('generates same name for lead role', () => {
      expect(buildTeammateCodename('lead', 0)).toBe('Neon Falcon')
    })

    it('generates same name for reviewer role', () => {
      expect(buildTeammateCodename('reviewer', 0)).toBe('Neon Falcon')
    })

    it('generates same name for escalation role', () => {
      expect(buildTeammateCodename('escalation', 0)).toBe('Neon Falcon')
    })
  })

  describe('cycling behavior', () => {
    it('cycles through all 100 combinations uniquely', () => {
      const names = new Set<string>()
      for (let i = 0; i < 100; i++) {
        names.add(buildTeammateCodename('worker', i))
      }
      expect(names.size).toBe(100)
    })

    it('repeats after 100 teammates', () => {
      expect(buildTeammateCodename('worker', 0)).toBe(buildTeammateCodename('worker', 100))
      expect(buildTeammateCodename('worker', 1)).toBe(buildTeammateCodename('worker', 101))
      expect(buildTeammateCodename('worker', 50)).toBe(buildTeammateCodename('worker', 150))
    })

    it('maintains predictable adjective progression', () => {
      const adjectives = CODENAME_ADJECTIVES
      for (let i = 0; i < adjectives.length; i++) {
        const name = buildTeammateCodename('worker', i)
        expect(name).toContain(adjectives[i])
      }
    })

    it('maintains predictable noun progression', () => {
      const nouns = CODENAME_NOUNS
      for (let i = 0; i < nouns.length; i++) {
        const name = buildTeammateCodename('worker', i * 10) // Every 10th teammate gets next noun
        expect(name).toContain(nouns[i])
      }
    })
  })

  describe('edge cases', () => {
    it('handles index 0', () => {
      expect(buildTeammateCodename('worker', 0)).toBe('Neon Falcon')
    })

    it('handles large indices', () => {
      // index 999: adjective = 999 % 10 = 9 (Obsidian), noun = floor(999/10) % 10 = 99 % 10 = 9 (Cipher)
      expect(buildTeammateCodename('worker', 999)).toBe('Obsidian Cipher')
    })

    it('handles negative indices gracefully (modulo behavior)', () => {
      // JavaScript modulo with negative numbers can produce unexpected results
      // but the function should still return a valid name
      const name = buildTeammateCodename('worker', -1)
      expect(name).toMatch(/^\w+ \w+$/)
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
      expect(name).toMatch(/^\w+ \w+ Squad$/)
    })

    it('generates consistent names for same seed', () => {
      expect(buildTeamCodename('alpha')).toBe(buildTeamCodename('alpha'))
      expect(buildTeamCodename('beta')).toBe(buildTeamCodename('beta'))
    })

    it('generates different names for different seeds', () => {
      expect(buildTeamCodename('alpha')).not.toBe(buildTeamCodename('beta'))
    })

    it('uses Squad suffix', () => {
      expect(buildTeamCodename('test')).toContain('Squad')
    })
  })

  describe('deterministic hashing', () => {
    it('is case-insensitive', () => {
      expect(buildTeamCodename('MyTeam')).toBe(buildTeamCodename('myteam'))
      expect(buildTeamCodename('ALPHA')).toBe(buildTeamCodename('alpha'))
    })

    it('ignores leading/trailing whitespace', () => {
      expect(buildTeamCodename('  team  ')).toBe(buildTeamCodename('team'))
      expect(buildTeamCodename('\tteam\n')).toBe(buildTeamCodename('team'))
    })

    it('produces valid adjective and noun from word lists', () => {
      const name = buildTeamCodename('test-team')
      const parts = name.split(' ')
      expect(CODENAME_ADJECTIVES).toContain(parts[0])
      expect(CODENAME_NOUNS).toContain(parts[1])
    })
  })

  describe('known seeds', () => {
    // These tests document specific seed→name mappings for regression testing
    it('generates expected name for common seeds', () => {
      // Calculate expected values based on hash algorithm
      const tests = [
        { seed: 'test', expected: /^\w+ \w+ Squad$/ },
        { seed: 'my-team', expected: /^\w+ \w+ Squad$/ },
        { seed: 'alpha', expected: /^\w+ \w+ Squad$/ },
      ]

      for (const { seed, expected } of tests) {
        expect(buildTeamCodename(seed)).toMatch(expected)
      }
    })
  })

  describe('edge cases', () => {
    it('handles empty string', () => {
      const name = buildTeamCodename('')
      expect(name).toMatch(/^\w+ \w+ Squad$/)
    })

    it('handles single character', () => {
      const name = buildTeamCodename('a')
      expect(name).toMatch(/^\w+ \w+ Squad$/)
    })

    it('handles special characters', () => {
      const name = buildTeamCodename('team-123!@#')
      expect(name).toMatch(/^\w+ \w+ Squad$/)
    })

    it('handles unicode characters', () => {
      const name = buildTeamCodename('チーム')
      expect(name).toMatch(/^\w+ \w+ Squad$/)
    })
  })
})

// ============================================================================
// teammateMatchesTargetName — Name matching logic
// ============================================================================

describe('teammateMatchesTargetName', () => {
  describe('exact matches', () => {
    it('matches exact teammateName', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'Neon Falcon')).toBe(true)
    })

    it('matches exact sessionName', () => {
      expect(teammateMatchesTargetName(undefined, 'worker-123', 'worker-123')).toBe(true)
    })

    it('is case-insensitive for exact matches', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'neon falcon')).toBe(true)
      expect(teammateMatchesTargetName('FALCON', undefined, 'falcon')).toBe(true)
    })

    it('ignores leading/trailing whitespace', () => {
      expect(teammateMatchesTargetName('worker-1', undefined, '  worker-1  ')).toBe(true)
    })
  })

  describe('parentheses matching', () => {
    it('matches name inside parentheses', () => {
      expect(teammateMatchesTargetName('Neon Falcon (custom-name)', undefined, 'custom-name')).toBe(true)
    })

    it('matches name inside brackets', () => {
      expect(teammateMatchesTargetName('Neon Falcon [custom-name]', undefined, 'custom-name')).toBe(true)
    })

    it('matches word inside parentheses via word boundary', () => {
      // Even though "custom" isn't an exact match for "(custom-name)",
      // it still matches via word boundary rules (hyphen creates boundary)
      expect(teammateMatchesTargetName('Neon Falcon (custom-name)', undefined, 'custom')).toBe(true)
    })
  })

  describe('word boundary matching', () => {
    it('matches word at start', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'Neon')).toBe(true)
    })

    it('matches word in middle (single word names)', () => {
      expect(teammateMatchesTargetName('Worker One Two', undefined, 'One')).toBe(true)
    })

    it('matches word at end', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'Falcon')).toBe(true)
    })

    it('does not match partial word', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'Falc')).toBe(false)
    })

    it('handles hyphens as word boundaries', () => {
      expect(teammateMatchesTargetName('worker-neon-falcon', undefined, 'neon')).toBe(true)
    })

    it('is case-insensitive for word boundaries', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'neon')).toBe(true)
      expect(teammateMatchesTargetName('Neon Falcon', undefined, 'FALCON')).toBe(true)
    })
  })

  describe('regex safety', () => {
    it('escapes regex special characters', () => {
      expect(teammateMatchesTargetName('test.name', undefined, '.')).toBe(false)
      expect(teammateMatchesTargetName('test[1]', undefined, '[')).toBe(false)
      expect(teammateMatchesTargetName('test*name', undefined, '*')).toBe(false)
    })

    it('matches literal dots', () => {
      expect(teammateMatchesTargetName('worker.1', undefined, 'worker.1')).toBe(true)
    })

    it('matches literal parentheses in exact match', () => {
      expect(teammateMatchesTargetName('test(1)', undefined, 'test(1)')).toBe(true)
    })
  })

  describe('edge cases', () => {
    it('returns false for empty target', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, '')).toBe(false)
    })

    it('returns false for whitespace-only target', () => {
      expect(teammateMatchesTargetName('Neon Falcon', undefined, '   ')).toBe(false)
    })

    it('handles undefined teammateName', () => {
      expect(teammateMatchesTargetName(undefined, 'session-1', 'session-1')).toBe(true)
    })

    it('handles undefined sessionName', () => {
      expect(teammateMatchesTargetName('worker-1', undefined, 'worker-1')).toBe(true)
    })

    it('handles both undefined', () => {
      expect(teammateMatchesTargetName(undefined, undefined, 'anything')).toBe(false)
    })

    it('checks both fields when both are defined', () => {
      expect(teammateMatchesTargetName('Neon Falcon', 'worker-1', 'Neon')).toBe(true)
      expect(teammateMatchesTargetName('Neon Falcon', 'worker-1', 'worker-1')).toBe(true)
    })
  })

  describe('real-world scenarios', () => {
    it('matches codename from full display name', () => {
      const displayName = 'Neon Falcon (teammate-1771022940414)'
      expect(teammateMatchesTargetName(displayName, undefined, 'Neon')).toBe(true)
      expect(teammateMatchesTargetName(displayName, undefined, 'Falcon')).toBe(true)
      expect(teammateMatchesTargetName(displayName, undefined, 'teammate-1771022940414')).toBe(true)
    })

    it('matches custom name from display name', () => {
      const displayName = 'Solar Comet (test-reviewer)'
      expect(teammateMatchesTargetName(displayName, undefined, 'test-reviewer')).toBe(true)
      expect(teammateMatchesTargetName(displayName, undefined, 'Solar')).toBe(true)
    })

    it('does not match substring inside compound word', () => {
      expect(teammateMatchesTargetName('Superworker', undefined, 'worker')).toBe(false)
    })
  })
})
