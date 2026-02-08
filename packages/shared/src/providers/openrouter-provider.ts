/**
 * OpenRouter Provider
 *
 * Fallback provider supporting many models via the OpenRouter API.
 * Useful for accessing a wide variety of models through a single API key.
 * Uses the OpenAI-compatible API format.
 */

import type { AvailableModel } from '@craft-agent/core/types';
import type { IModelProvider, IWorkerAgent, WorkerToolDef } from './types.ts';
import type { WorkerTask, WorkerMessage } from '@craft-agent/core/types';
import { randomUUID } from 'crypto';

// Popular models available on OpenRouter (subset — more can be discovered via API)
const OPENROUTER_MODELS: AvailableModel[] = [
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'openrouter',
    capabilities: ['reasoning', 'coding', 'tool-use', 'vision', 'long-context'],
    costPer1MInput: 2.5,
    costPer1MOutput: 15,
    maxContext: 1048576,
    supportsToolUse: true,
    recommendedRoles: ['head', 'worker'],
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'openrouter',
    capabilities: ['reasoning', 'coding', 'tool-use'],
    costPer1MInput: 0.55,
    costPer1MOutput: 2.19,
    maxContext: 65536,
    supportsToolUse: true,
    recommendedRoles: ['worker'],
  },
  {
    id: 'meta-llama/llama-4-maverick',
    name: 'Llama 4 Maverick',
    provider: 'openrouter',
    capabilities: ['coding', 'tool-use', 'fast'],
    costPer1MInput: 0.2,
    costPer1MOutput: 0.6,
    maxContext: 131072,
    supportsToolUse: true,
    recommendedRoles: ['worker'],
  },
];

export class OpenRouterProvider implements IModelProvider {
  readonly id = 'openrouter';
  readonly name = 'OpenRouter';
  private apiKey: string | null = null;

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  getModels(): AvailableModel[] {
    return OPENROUTER_MODELS;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  createWorker(modelId: string): IWorkerAgent {
    if (!this.apiKey) {
      throw new Error('OpenRouter API key not configured');
    }
    return new OpenRouterWorkerAgent(modelId, this.apiKey);
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * OpenRouter worker agent — executes tasks via the OpenRouter API.
 * Similar pattern to the Kimi worker, but using the OpenRouter endpoint.
 */
class OpenRouterWorkerAgent implements IWorkerAgent {
  readonly id: string;
  readonly model: string;
  readonly provider = 'openrouter';
  status: 'idle' | 'working' | 'error' = 'idle';

  private apiKey: string;
  private abortController: AbortController | null = null;
  private messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];

  constructor(model: string, apiKey: string) {
    this.id = `openrouter-worker-${randomUUID().slice(0, 8)}`;
    this.model = model;
    this.apiKey = apiKey;
  }

  async *execute(task: WorkerTask, tools: WorkerToolDef[]): AsyncGenerator<WorkerMessage> {
    this.status = 'working';
    this.abortController = new AbortController();

    this.messages = [
      {
        role: 'system',
        content: `You are a worker agent executing a specific task. Complete the task using the available tools.\n\nTask: ${task.description}${task.context ? `\n\nContext: ${task.context}` : ''}`,
      },
      {
        role: 'user',
        content: task.description,
      },
    ];

    const openaiTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    try {
      let maxIterations = 50;
      while (maxIterations-- > 0) {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://craftagents.app',
            'X-Title': 'Craft Agents - Agent Teams',
          },
          body: JSON.stringify({
            model: this.model,
            messages: this.messages,
            tools: openaiTools.length > 0 ? openaiTools : undefined,
            tool_choice: 'auto',
          }),
          signal: this.abortController.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          yield { type: 'error', content: `OpenRouter API error: ${response.status} ${errorText}` };
          this.status = 'error';
          return;
        }

        const data = await response.json() as {
          choices: Array<{
            message: {
              role: string;
              content: string | null;
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            };
            finish_reason: string;
          }>;
        };

        const choice = data.choices[0];
        if (!choice) {
          yield { type: 'error', content: 'No response from OpenRouter' };
          this.status = 'error';
          return;
        }

        const message = choice.message;

        if (message.content) {
          yield { type: 'text', content: message.content };
        }

        if (message.tool_calls && message.tool_calls.length > 0) {
          this.messages.push({
            role: 'assistant',
            content: message.content || '',
            tool_calls: message.tool_calls,
          });

          for (const toolCall of message.tool_calls) {
            const toolInput = JSON.parse(toolCall.function.arguments);
            yield {
              type: 'tool_call',
              content: `Calling ${toolCall.function.name}`,
              toolName: toolCall.function.name,
              toolInput,
            };
          }
        }

        if (!message.tool_calls || message.tool_calls.length === 0) {
          yield { type: 'complete', content: message.content || 'Task completed' };
          this.status = 'idle';
          return;
        }
      }

      yield { type: 'error', content: 'Max iterations reached' };
      this.status = 'error';
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        yield { type: 'complete', content: 'Worker shut down' };
      } else {
        yield { type: 'error', content: `Worker error: ${(err as Error).message}` };
        this.status = 'error';
      }
    }
  }

  async sendMessage(msg: string): Promise<void> {
    this.messages.push({ role: 'user', content: msg });
  }

  async shutdown(): Promise<void> {
    this.abortController?.abort();
    this.status = 'idle';
  }
}
