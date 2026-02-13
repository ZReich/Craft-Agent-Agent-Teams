import { describe, it, expect } from 'vitest';
import { mergeQualityGateConfig } from '../quality-gates';

describe('quality-gates config inference', () => {
  it('infers openai escalation provider from codex escalation model when unset', () => {
    const merged = mergeQualityGateConfig({
      escalationModel: 'gpt-5.3-codex',
      escalationProvider: undefined,
    });

    expect(merged.escalationProvider).toBe('openai');
  });

  it('preserves explicit escalation provider when provided', () => {
    const merged = mergeQualityGateConfig({
      escalationModel: 'gpt-5.3-codex',
      escalationProvider: 'anthropic',
    });

    expect(merged.escalationProvider).toBe('anthropic');
  });
});
