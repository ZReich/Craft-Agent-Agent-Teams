/**
 * Provider Registry
 *
 * Central registry for all model providers. Manages provider instances,
 * API key configuration, and model discovery.
 */

import type { ModelProvider, AvailableModel } from '@craft-agent/core/types';
import type { IModelProvider } from './types.ts';
import { AnthropicProvider } from './anthropic-provider.ts';
import { KimiProvider } from './kimi-provider.ts';
import { OpenRouterProvider } from './openrouter-provider.ts';

/**
 * Global provider registry — singleton that manages all configured providers
 */
class ProviderRegistry {
  private providers = new Map<string, IModelProvider>();

  constructor() {
    // Register built-in providers (API keys configured later)
    this.register(new AnthropicProvider());
    this.register(new KimiProvider());
    this.register(new OpenRouterProvider());
  }

  /** Register a new provider */
  register(provider: IModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  /** Get a provider by ID */
  get(id: string): IModelProvider | undefined {
    return this.providers.get(id);
  }

  /** Get all registered providers */
  getAll(): IModelProvider[] {
    return Array.from(this.providers.values());
  }

  /** Get provider summaries for UI display */
  getProviderSummaries(): ModelProvider[] {
    return this.getAll().map(p => ({
      id: p.id,
      name: p.name,
      apiKeyConfigured: p.isConfigured(),
      models: p.getModels(),
    }));
  }

  /** Get all available models across all configured providers */
  getAllModels(): AvailableModel[] {
    return this.getAll()
      .filter(p => p.isConfigured())
      .flatMap(p => p.getModels());
  }

  /** Find a specific model by ID across all providers */
  findModel(modelId: string): AvailableModel | undefined {
    for (const provider of this.providers.values()) {
      const model = provider.getModels().find(m => m.id === modelId);
      if (model) return model;
    }
    return undefined;
  }

  /** Create a worker agent for a specific model */
  createWorker(modelId: string, providerId: string) {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Provider not found: ${providerId}`);
    }
    if (!provider.isConfigured()) {
      throw new Error(`Provider ${providerId} is not configured (missing API key)`);
    }
    return provider.createWorker(modelId);
  }
}

/** Singleton instance */
export const providerRegistry = new ProviderRegistry();
