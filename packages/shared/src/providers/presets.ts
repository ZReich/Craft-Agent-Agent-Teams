/**
 * Model Presets
 *
 * Pre-configured model assignments for common team configurations.
 * Users can select a preset to quickly configure their team's models.
 */

import type { ModelPreset, ModelPresetId, TeamModelConfig } from '@craft-agent/core/types';

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'max-quality',
    name: 'Max Quality',
    description: 'Opus everywhere — best results, highest cost',
    costIndicator: '$$$$',
    config: {
      defaults: {
        lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
        head: { model: 'claude-opus-4-6', provider: 'anthropic' },
        worker: { model: 'claude-opus-4-6', provider: 'anthropic' },
        reviewer: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        escalation: { model: 'claude-opus-4-6', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Opus lead, Sonnet heads and workers — good quality, moderate cost',
    costIndicator: '$$$',
    config: {
      defaults: {
        lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
        head: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        worker: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-opus-4-6', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'cost-optimized',
    name: 'Cost Optimized',
    description: 'Opus lead, Sonnet heads, Kimi workers — balanced with low-cost workers',
    costIndicator: '$$',
    config: {
      defaults: {
        lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
        head: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        worker: { model: 'kimi-k2.5', provider: 'moonshot' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'budget',
    name: 'Budget',
    description: 'Sonnet lead, Kimi workers — most cost-effective option',
    costIndicator: '$',
    config: {
      defaults: {
        lead: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        head: { model: 'kimi-k2.5', provider: 'moonshot' },
        worker: { model: 'kimi-k2.5', provider: 'moonshot' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'You choose the model for every role',
    costIndicator: '$',
    config: {
      defaults: {
        lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
        head: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        worker: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-opus-4-6', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'codex-balanced',
    name: 'Codex Balanced',
    description: 'Codex lead/head, Sonnet workers â€” Codex reasoning with Claude throughput',
    costIndicator: '$$$',
    config: {
      defaults: {
        lead: { model: 'gpt-5.3-codex', provider: 'openai' },
        head: { model: 'gpt-5.3-codex', provider: 'openai' },
        worker: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
      },
    },
  },
  {
    id: 'codex-full',
    name: 'Codex Full',
    description: 'Codex everywhere â€” maximum OpenAI reasoning',
    costIndicator: '$$$$',
    config: {
      defaults: {
        lead: { model: 'gpt-5.3-codex', provider: 'openai' },
        head: { model: 'gpt-5.3-codex', provider: 'openai' },
        worker: { model: 'gpt-5.1-codex-mini', provider: 'openai' },
        reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
        escalation: { model: 'claude-opus-4-6', provider: 'anthropic' },
      },
    },
  },
];

/** Get a preset by ID */
export function getPreset(id: ModelPresetId): ModelPreset | undefined {
  return MODEL_PRESETS.find(p => p.id === id);
}

/** Get the default preset */
export function getDefaultPreset(): ModelPreset {
  return MODEL_PRESETS.find(p => p.id === 'cost-optimized')!;
}

/** Estimate hourly cost for a team configuration (rough, based on typical token usage) */
export function estimateHourlyCost(config: TeamModelConfig, teammateCount: number): number {
  // Rough estimates based on typical agentic usage patterns:
  // Lead: ~500K input + 200K output tokens/hour
  // Head: ~300K input + 100K output tokens/hour each
  // Worker: ~200K input + 150K output tokens/hour each

  const findCost = (assignment: { model: string; provider: string }) => {
    // Import models from providers to get cost data
    const costMap: Record<string, { input: number; output: number }> = {
      'claude-opus-4-6': { input: 15, output: 75 },
      'claude-sonnet-4-5-20250929': { input: 3, output: 15 },
      'claude-haiku-4-5-20251001': { input: 0.8, output: 4 },
      'kimi-k2.5': { input: 1.5, output: 7.5 },
    };
    return costMap[assignment.model] || { input: 3, output: 15 }; // Default to Sonnet-tier
  };

  const leadCost = findCost(config.defaults.lead);
  const workerCost = findCost(config.defaults.worker);
  const reviewerCost = findCost(config.defaults.reviewer);

  // Lead cost (1 lead)
  const leadHourlyCost = (500000 * leadCost.input + 200000 * leadCost.output) / 1000000;

  // Worker cost (N workers)
  const workerHourlyCost = teammateCount * (200000 * workerCost.input + 150000 * workerCost.output) / 1000000;

  // Reviewer cost (~10K tokens per review, ~3 reviews per worker per hour)
  const reviewerHourlyCost = teammateCount * 3 * (8000 * reviewerCost.input + 2000 * reviewerCost.output) / 1000000;

  return leadHourlyCost + workerHourlyCost + reviewerHourlyCost;
}
