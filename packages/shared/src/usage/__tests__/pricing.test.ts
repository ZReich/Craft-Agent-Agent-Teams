import { describe, it, expect } from 'bun:test';
import {
  inferProviderFromModel,
  getModelPricing,
  calculateTokenCostUsd,
} from '../../usage/pricing.ts';

describe('inferProviderFromModel', () => {
  it('returns anthropic for Claude models', () => {
    expect(inferProviderFromModel('claude-sonnet-4-5')).toBe('anthropic');
    expect(inferProviderFromModel('claude-opus-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('claude-haiku-4-5')).toBe('anthropic');
  });

  it('returns openai for GPT models', () => {
    expect(inferProviderFromModel('gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('gpt-5.3-codex')).toBe('openai');
    expect(inferProviderFromModel('gpt-4o-mini')).toBe('openai');
  });

  it('returns openai for codex models', () => {
    expect(inferProviderFromModel('codex-mini')).toBe('openai');
  });

  it('returns openai for o1/o3 models', () => {
    expect(inferProviderFromModel('o1-preview')).toBe('openai');
    expect(inferProviderFromModel('o3-mini')).toBe('openai');
  });

  it('returns moonshot for Kimi models', () => {
    expect(inferProviderFromModel('kimi-k2.5')).toBe('moonshot');
    expect(inferProviderFromModel('kimi-k2-thinking')).toBe('moonshot');
  });

  it('returns moonshot for Moonshot models', () => {
    expect(inferProviderFromModel('moonshot-v1-auto')).toBe('moonshot');
  });

  it('returns openrouter for unknown models', () => {
    expect(inferProviderFromModel('llama-3')).toBe('openrouter');
    expect(inferProviderFromModel('mistral-large')).toBe('openrouter');
  });

  it('strips provider prefix before matching', () => {
    expect(inferProviderFromModel('anthropic/claude-sonnet-4-5')).toBe('anthropic');
    expect(inferProviderFromModel('openai/gpt-4o')).toBe('openai');
    expect(inferProviderFromModel('openrouter/claude-opus-4-6')).toBe('anthropic');
  });

  it('returns openrouter for undefined or empty input', () => {
    expect(inferProviderFromModel(undefined)).toBe('openrouter');
    expect(inferProviderFromModel('')).toBe('openrouter');
    expect(inferProviderFromModel('  ')).toBe('openrouter');
  });

  it('is case-insensitive', () => {
    expect(inferProviderFromModel('Claude-Opus-4-6')).toBe('anthropic');
    expect(inferProviderFromModel('GPT-4o')).toBe('openai');
    expect(inferProviderFromModel('KIMI-K2.5')).toBe('moonshot');
  });
});

describe('getModelPricing', () => {
  it('returns exact pricing for known models', () => {
    const pricing = getModelPricing('claude-opus-4-6');
    expect(pricing.inputPerMillion).toBe(5);
    expect(pricing.outputPerMillion).toBe(25);
  });

  it('returns pricing with cached input for models that support it', () => {
    const pricing = getModelPricing('gpt-5.3-codex');
    expect(pricing.inputPerMillion).toBe(1.25);
    expect(pricing.outputPerMillion).toBe(10);
    expect(pricing.cachedInputPerMillion).toBe(0.125);
  });

  it('returns provider default pricing for unknown model with provider hint', () => {
    const pricing = getModelPricing('some-unknown-model', 'anthropic');
    expect(pricing.inputPerMillion).toBe(3);
    expect(pricing.outputPerMillion).toBe(15);
  });

  it('infers provider and returns its defaults for unknown model without hint', () => {
    // 'llama-3' doesn't match any known model or provider keyword → openrouter
    const pricing = getModelPricing('llama-3');
    expect(pricing.inputPerMillion).toBe(2.5);
    expect(pricing.outputPerMillion).toBe(10);
  });

  it('strips provider prefix and resolves known model', () => {
    const pricing = getModelPricing('anthropic/claude-opus-4-6');
    expect(pricing.inputPerMillion).toBe(5);
    expect(pricing.outputPerMillion).toBe(25);
  });

  it('returns openrouter defaults for undefined model', () => {
    const pricing = getModelPricing(undefined);
    expect(pricing.inputPerMillion).toBe(2.5);
    expect(pricing.outputPerMillion).toBe(10);
  });

  it('provider hint overrides inferred provider for unknown models', () => {
    const pricing = getModelPricing('unknown-model', 'moonshot');
    expect(pricing.inputPerMillion).toBe(0.28);
    expect(pricing.outputPerMillion).toBe(0.28);
  });
});

describe('calculateTokenCostUsd', () => {
  it('returns 0 for zero tokens', () => {
    expect(calculateTokenCostUsd({ model: 'claude-opus-4-6', inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('returns 0 when all params are zero', () => {
    expect(calculateTokenCostUsd({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })).toBe(0);
  });

  it('returns 0 when no token params provided', () => {
    expect(calculateTokenCostUsd({ model: 'claude-opus-4-6' })).toBe(0);
  });

  it('calculates simple input + output cost', () => {
    // claude-opus-4-6: input=5/M, output=25/M
    // 1M input + 1M output = 5 + 25 = 30
    const cost = calculateTokenCostUsd({
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(30);
  });

  it('calculates cache-aware pricing correctly', () => {
    // gpt-5.3-codex: input=1.25/M, output=10/M, cachedInput=0.125/M
    // 1M total input, 500K cached → 500K non-cached at 1.25/M + 500K cached at 0.125/M
    // (500_000/1_000_000)*1.25 + (500_000/1_000_000)*0.125 = 0.625 + 0.0625 = 0.6875
    const cost = calculateTokenCostUsd({
      model: 'gpt-5.3-codex',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 500_000,
    });
    expect(cost).toBeCloseTo(0.6875, 10);
  });

  it('uses regular input price for cached tokens when no cache pricing exists', () => {
    // claude-opus-4-6: input=5/M, output=25/M, no cachedInputPerMillion
    // 1M total input, 500K cached → 500K non-cached at 5/M + 500K cached at 5/M (fallback)
    // (500_000/1_000_000)*5 + (500_000/1_000_000)*5 = 2.5 + 2.5 = 5
    const cost = calculateTokenCostUsd({
      model: 'claude-opus-4-6',
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 500_000,
    });
    expect(cost).toBe(5);
  });

  it('uses openrouter defaults for undefined model', () => {
    // openrouter: input=2.5/M, output=10/M
    // 1M input + 1M output = 2.5 + 10 = 12.5
    const cost = calculateTokenCostUsd({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(12.5);
  });

  it('handles output-only usage', () => {
    // claude-sonnet-4-5: output=15/M
    const cost = calculateTokenCostUsd({
      model: 'claude-sonnet-4-5',
      outputTokens: 1_000_000,
    });
    expect(cost).toBe(15);
  });

  it('handles input-only usage', () => {
    // claude-sonnet-4-5: input=3/M
    const cost = calculateTokenCostUsd({
      model: 'claude-sonnet-4-5',
      inputTokens: 1_000_000,
    });
    expect(cost).toBe(3);
  });

  it('clamps non-cached input to zero when cached exceeds input', () => {
    // If cachedInputTokens > inputTokens, nonCachedInput = max(0, input - cached) = 0
    // gpt-4o: input=2.5/M, cachedInput=1.25/M
    // 500K input, 1M cached → nonCached = max(0, 500K - 1M) = 0
    // cached cost = (1_000_000/1_000_000)*1.25 = 1.25
    const cost = calculateTokenCostUsd({
      model: 'gpt-4o',
      inputTokens: 500_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(cost).toBe(1.25);
  });

  it('respects provider hint for cost calculation', () => {
    // Unknown model with moonshot hint: input=0.28/M, output=0.28/M
    const cost = calculateTokenCostUsd({
      model: 'some-custom-model',
      provider: 'moonshot',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.56, 10);
  });

  it('returns 0 for negative token counts', () => {
    expect(calculateTokenCostUsd({
      model: 'claude-opus-4-6',
      inputTokens: -100,
      outputTokens: -100,
    })).toBe(0);
  });
});
