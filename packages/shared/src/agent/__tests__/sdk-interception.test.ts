import { describe, expect, it } from 'vitest';
import {
  buildOverrideSnippet,
  createToolOverrideResult,
  didToolOverrideApply,
} from '../sdk-interception.ts';

describe('sdk-interception helpers (REQ-NEXT-007)', () => {
  it('creates a tool override payload with outputContent', () => {
    const result = createToolOverrideResult('intercepted');
    expect(result).toEqual({ outputContent: 'intercepted' });
  });

  it('builds snippet from first meaningful line', () => {
    const snippet = buildOverrideSnippet('\n\n  Team created successfully.\nMore details');
    expect(snippet).toBe('Team created successfully.');
  });

  it('caps snippets at 160 chars', () => {
    const long = 'x'.repeat(300);
    const snippet = buildOverrideSnippet(long);
    expect(snippet.length).toBe(160);
  });

  it('verifies override application against tool response text', () => {
    expect(didToolOverrideApply('Team created successfully.', 'Team created')).toBe(true);
    expect(didToolOverrideApply('Different response', 'Team created')).toBe(false);
    expect(didToolOverrideApply({} as unknown, 'Team created')).toBe(false);
  });
});

