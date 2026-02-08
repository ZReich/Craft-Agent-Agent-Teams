/**
 * Providers Module
 *
 * Multi-model provider system for agent teams.
 * Supports Anthropic (Claude), Moonshot (Kimi), and OpenRouter.
 */

// Types
export type {
  IModelProvider,
  IWorkerAgent,
  WorkerToolDef,
  WorkerToolCall,
  ProviderConfig,
  ToolExecutor,
} from './types.ts';

// Registry singleton
export { providerRegistry } from './registry.ts';

// Individual providers (for direct access if needed)
export { AnthropicProvider } from './anthropic-provider.ts';
export { KimiProvider } from './kimi-provider.ts';
export { OpenRouterProvider } from './openrouter-provider.ts';

// Presets
export { MODEL_PRESETS, getPreset, getDefaultPreset, estimateHourlyCost } from './presets.ts';
