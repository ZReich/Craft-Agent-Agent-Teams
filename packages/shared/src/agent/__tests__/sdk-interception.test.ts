// Implements REQ-NEXT-007: Stabilize SDK interception layer.
// createToolOverrideResult / buildOverrideSnippet / didToolOverrideApply removed —
// the SDK does not process outputContent; agent team tools now use decision:'block'.
import { describe, expect, it } from 'vitest';
import { didToolOverrideMatch } from '../sdk-interception.ts';

describe('sdk-interception helpers (REQ-NEXT-007)', () => {
  it('matches expected snippet in actual result', () => {
    expect(didToolOverrideMatch('Team created', 'Team created successfully.')).toBe(true);
    expect(didToolOverrideMatch('Team created', 'Different response')).toBe(false);
    expect(didToolOverrideMatch('', 'anything')).toBe(true);
    expect(didToolOverrideMatch('something', '')).toBe(false);
  });
});
