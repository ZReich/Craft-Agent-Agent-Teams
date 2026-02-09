import { describe, it, expect } from 'bun:test';
import { resolveReviewProvider } from '../src/agent-teams/review-provider';

describe('resolveReviewProvider', () => {
  it('detects Moonshot/Kimi models', () => {
    expect(resolveReviewProvider('kimi-k2.5')).toBe('moonshot');
  });

  it('detects Codex/OpenAI models', () => {
    expect(resolveReviewProvider('gpt-5.3-codex')).toBe('openai');
    expect(resolveReviewProvider('gpt-5.1-codex-mini')).toBe('openai');
  });

  it('defaults to Anthropic for Claude models', () => {
    expect(resolveReviewProvider('claude-opus-4-6')).toBe('anthropic');
    expect(resolveReviewProvider('claude-sonnet-4-5-20250929')).toBe('anthropic');
  });
});
