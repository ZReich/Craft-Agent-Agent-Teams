import { describe, expect, it } from 'vitest'
import { QUALITY_GATE_HELP, parseKnownFailingTests, stringifyKnownFailingTests } from '../qualityGateHelp'

describe('qualityGateHelp utilities', () => {
  it('parses known failing tests from newline and comma separated input', () => {
    const parsed = parseKnownFailingTests('a.test.ts\nb.test.ts, c.test.ts \n a.test.ts')
    expect(parsed).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts'])
  })

  it('stringifies known failing tests list for textarea display', () => {
    expect(stringifyKnownFailingTests(['a.test.ts', 'b.test.ts'])).toBe('a.test.ts\nb.test.ts')
    expect(stringifyKnownFailingTests([])).toBe('')
    expect(stringifyKnownFailingTests(undefined)).toBe('')
  })

  it('includes hover help entries for all quality gate toggles', () => {
    expect(QUALITY_GATE_HELP.syntax.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.tests.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.architecture.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.simplicity.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.errors.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.completeness.whyEnable.length).toBeGreaterThan(0)
    expect(QUALITY_GATE_HELP.baselineAwareTests.whyEnable.length).toBeGreaterThan(0)
  })
})

