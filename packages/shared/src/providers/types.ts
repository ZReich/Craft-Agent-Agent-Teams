/**
 * Provider Types
 *
 * Model-agnostic interfaces for calling any LLM with tool use.
 * Providers implement these interfaces to support multi-model teams.
 */

import type {
  AvailableModel,
  WorkerMessage,
  WorkerTask,
} from '@craft-agent/core/types';

/**
 * Tool definition for non-Claude workers.
 * Simplified version of the Claude tool schema.
 */
export interface WorkerToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A tool call from a worker agent
 */
export interface WorkerToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Configuration for a model provider
 */
export interface ProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string;
}

/**
 * Interface that all model providers must implement.
 * Providers handle the actual API communication with different LLM services.
 */
export interface IModelProvider {
  readonly id: string;
  readonly name: string;

  /** Check if the provider is configured (API key set) */
  isConfigured(): boolean;

  /** Get available models from this provider */
  getModels(): AvailableModel[];

  /** Create a worker agent instance using this provider */
  createWorker(modelId: string): IWorkerAgent;

  /** Test the connection with a simple ping */
  testConnection(): Promise<boolean>;
}

/**
 * Interface for worker agents — any model that can execute tasks.
 * Claude teammates use the native SDK; non-Claude workers implement this.
 */
export interface IWorkerAgent {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  status: 'idle' | 'working' | 'error';

  /** Execute a task, streaming results back */
  execute(task: WorkerTask, tools: WorkerToolDef[]): AsyncGenerator<WorkerMessage>;

  /** Send a message to the worker mid-task */
  sendMessage(msg: string): Promise<void>;

  /** Gracefully shut down the worker */
  shutdown(): Promise<void>;
}

/**
 * Tool executor function — called by the worker's tool-use loop
 * to actually run tools (Read, Write, Bash, etc.)
 */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  workingDirectory?: string
) => Promise<string>;
