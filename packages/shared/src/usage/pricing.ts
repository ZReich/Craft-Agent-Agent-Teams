/**
 * Provider/model pricing utilities for usage tracking.
 *
 * All prices are USD per 1M tokens unless noted.
 */

export type UsageProvider = 'anthropic' | 'openai' | 'moonshot' | 'openrouter';

export interface ModelPricing {
  /** Input token price per 1M tokens */
  inputPerMillion: number;
  /** Output token price per 1M tokens */
  outputPerMillion: number;
  /**
   * Cached input token price per 1M tokens (if provider supports discounted cache reads).
   * Defaults to inputPerMillion when omitted.
   */
  cachedInputPerMillion?: number;
}

const DEFAULT_PROVIDER_PRICING: Record<UsageProvider, ModelPricing> = {
  anthropic: { inputPerMillion: 3, outputPerMillion: 15 },
  openai: { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  moonshot: { inputPerMillion: 0.28, outputPerMillion: 0.28 },
  openrouter: { inputPerMillion: 2.5, outputPerMillion: 10 },
};

/**
 * Model-specific overrides.
 *
 * Sources consulted (Feb 9, 2026):
 * - OpenAI API pricing: https://openai.com/api/pricing/
 * - Anthropic model docs and pricing pages:
 *   https://www.anthropic.com/news/claude-sonnet-4
 *   https://www.anthropic.com/pricing
 * - Moonshot public pricing references:
 *   https://platform.moonshot.ai/docs/pricing/chat
 */
const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6': { inputPerMillion: 5, outputPerMillion: 25 },
  'claude-opus-4-1': { inputPerMillion: 15, outputPerMillion: 75 },
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-sonnet-4': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-haiku-4-5': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'claude-haiku-3-5': { inputPerMillion: 0.8, outputPerMillion: 4 },

  // OpenAI
  'gpt-5.3-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 },
  'gpt-5.2-codex': { inputPerMillion: 1.25, outputPerMillion: 10, cachedInputPerMillion: 0.125 },
  'gpt-5.1-codex-mini': { inputPerMillion: 0.25, outputPerMillion: 2, cachedInputPerMillion: 0.025 },
  'codex-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10, cachedInputPerMillion: 1.25 },
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6, cachedInputPerMillion: 0.075 },

  // Moonshot / Kimi
  'moonshot-v1-auto': { inputPerMillion: 0.28, outputPerMillion: 0.28 },
  'kimi-k2.5': { inputPerMillion: 0.28, outputPerMillion: 0.28 },
  'kimi-k2-thinking': { inputPerMillion: 0.6, outputPerMillion: 2.5 },
};

function normalizeModelId(model?: string): string {
  if (!model) return '';
  const trimmed = model.trim().toLowerCase();
  // Handle provider-prefixed IDs like "openai/gpt-4o" or "anthropic/claude-sonnet-4-5"
  const slashIndex = trimmed.indexOf('/');
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

export function inferProviderFromModel(model?: string): UsageProvider {
  const id = normalizeModelId(model);
  if (id.includes('claude')) return 'anthropic';
  if (id.includes('kimi') || id.includes('moonshot')) return 'moonshot';
  if (id.includes('gpt') || id.includes('codex') || id.includes('o1') || id.includes('o3')) return 'openai';
  return 'openrouter';
}

export function getModelPricing(model: string | undefined, providerHint?: UsageProvider): ModelPricing {
  const normalized = normalizeModelId(model);
  if (normalized && MODEL_PRICING[normalized]) {
    return MODEL_PRICING[normalized];
  }

  const inferredProvider = providerHint ?? inferProviderFromModel(model);
  return DEFAULT_PROVIDER_PRICING[inferredProvider];
}

export function calculateTokenCostUsd(params: {
  model?: string;
  provider?: UsageProvider;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}): number {
  const input = params.inputTokens ?? 0;
  const output = params.outputTokens ?? 0;
  const cached = params.cachedInputTokens ?? 0;
  if (input <= 0 && output <= 0 && cached <= 0) return 0;

  const pricing = getModelPricing(params.model, params.provider);
  const nonCachedInput = Math.max(0, input - cached);
  const cachedPrice = pricing.cachedInputPerMillion ?? pricing.inputPerMillion;

  const inputCost = (nonCachedInput / 1_000_000) * pricing.inputPerMillion;
  const cachedCost = (cached / 1_000_000) * cachedPrice;
  const outputCost = (output / 1_000_000) * pricing.outputPerMillion;

  return inputCost + cachedCost + outputCost;
}
