/**
 * Anthropic Provider
 *
 * Wraps Claude models (Opus 4.6, Sonnet 4.5, Haiku 4.5).
 * For team leads and heads, Claude teammates use the native SDK.
 * For workers, this provider creates a tool-use loop via the Anthropic API.
 */

import type { AvailableModel } from '@craft-agent/core/types';
import type { IModelProvider, IWorkerAgent } from './types.ts';

const ANTHROPIC_MODELS: AvailableModel[] = [
  {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    capabilities: ['reasoning', 'coding', 'tool-use', 'vision', 'long-context'],
    costPer1MInput: 15,
    costPer1MOutput: 75,
    maxContext: 200000,
    supportsToolUse: true,
    recommendedRoles: ['lead'],
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    capabilities: ['reasoning', 'coding', 'tool-use', 'fast', 'vision'],
    costPer1MInput: 3,
    costPer1MOutput: 15,
    maxContext: 200000,
    supportsToolUse: true,
    recommendedRoles: ['head', 'worker'],
  },
  {
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    capabilities: ['coding', 'tool-use', 'fast'],
    costPer1MInput: 0.8,
    costPer1MOutput: 4,
    maxContext: 200000,
    supportsToolUse: true,
    recommendedRoles: ['worker'],
  },
];

export class AnthropicProvider implements IModelProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  private apiKey: string | null = null;

  isConfigured(): boolean {
    // Anthropic auth is handled by the SDK (OAuth or API key)
    // We always consider it configured since Craft Agents requires it for the lead
    return true;
  }

  getModels(): AvailableModel[] {
    return ANTHROPIC_MODELS;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  createWorker(_modelId: string): IWorkerAgent {
    // Claude workers use the native SDK agent teams mechanism,
    // not a custom worker. This is a placeholder for direct API workers.
    throw new Error(
      'Claude workers should use the native SDK team tools, not the worker abstraction. ' +
      'Use providerRegistry.createWorker() only for non-Claude models.'
    );
  }

  async testConnection(): Promise<boolean> {
    // SDK handles connection testing
    return true;
  }
}
