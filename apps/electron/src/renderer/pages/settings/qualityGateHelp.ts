export type QualityGateStageKey =
  | 'syntax'
  | 'tests'
  | 'architecture'
  | 'simplicity'
  | 'errors'
  | 'completeness'

export interface QualityGateHelpEntry {
  title: string
  meaning: string
  whyEnable: string
}

export const QUALITY_GATE_HELP: Record<QualityGateStageKey | 'baselineAwareTests', QualityGateHelpEntry> = {
  syntax: {
    title: 'Syntax & Types',
    meaning: 'Runs compile/type checks to catch broken imports, type errors, and invalid code before review.',
    whyEnable: 'Fast and cheap guardrail that prevents obvious breakages from reaching later, costlier stages.',
  },
  tests: {
    title: 'Test Execution',
    meaning: 'Runs project tests to verify behavior and catch regressions introduced by teammate changes.',
    whyEnable: 'Best indicator of real behavior correctness and protects against silent functionality drift.',
  },
  architecture: {
    title: 'Architecture Review',
    meaning: 'Evaluates structure, boundaries, and design choices against maintainable project patterns.',
    whyEnable: 'Keeps codebase coherent over time and reduces costly refactors caused by ad-hoc structure.',
  },
  simplicity: {
    title: 'Simplicity Review',
    meaning: 'Checks for unnecessary complexity, over-abstraction, and readability issues.',
    whyEnable: 'Simpler code lowers onboarding time, reduces bugs, and speeds up future changes.',
  },
  errors: {
    title: 'Error Analysis',
    meaning: 'Looks for missing edge-case handling, weak failure paths, and reliability/security gaps.',
    whyEnable: 'Prevents production incidents by enforcing defensive handling before code is accepted.',
  },
  completeness: {
    title: 'Completeness Check',
    meaning: 'Validates that requested work is fully delivered without TODOs, stubs, or missing pieces.',
    whyEnable: 'Ensures task closure quality so teams do not accumulate hidden unfinished work.',
  },
  baselineAwareTests: {
    title: 'Baseline-aware Tests',
    meaning: 'Allows known pre-existing failing tests to be tracked separately from new failures.',
    whyEnable: 'Helps teams improve incrementally without blocking all progress on legacy failures.',
  },
}

export function parseKnownFailingTests(input: string): string[] {
  if (!input.trim()) return []
  return [...new Set(
    input
      .split(/\r?\n|,/g)
      .map((entry) => entry.trim())
      .filter(Boolean)
  )]
}

export function stringifyKnownFailingTests(entries: string[] | undefined): string {
  if (!entries || entries.length === 0) return ''
  return entries.join('\n')
}

