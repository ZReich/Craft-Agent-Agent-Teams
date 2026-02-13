import { isCodexModel } from '../config/models';

export type ReviewProvider = 'moonshot' | 'anthropic' | 'openai';

export function resolveReviewProvider(model: string, fallback?: string): ReviewProvider {
  const lower = model.toLowerCase();
  if (lower.startsWith('kimi-')) return 'moonshot';
  if (isCodexModel(model) || lower.startsWith('gpt-') || lower.startsWith('openai/')) return 'openai';
  if (lower.startsWith('claude-') || lower.startsWith('anthropic/')) return 'anthropic';
  if (fallback === 'moonshot' || fallback === 'openai') return fallback as ReviewProvider;
  return 'anthropic';
}
