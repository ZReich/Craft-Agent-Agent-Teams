/**
 * Kimi (Moonshot) Provider
 *
 * Wraps Kimi K2.5 — a cost-effective model for worker tasks.
 * Supports tool use via the OpenAI-compatible Moonshot API.
 * ~10x cheaper than Opus for routine coding tasks.
 */

import type { AvailableModel } from '@craft-agent/core/types';
import type { IModelProvider, IWorkerAgent, WorkerToolDef } from './types.ts';
import type { WorkerTask, WorkerMessage } from '@craft-agent/core/types';
import { randomUUID } from 'crypto';

const KIMI_MODELS: AvailableModel[] = [
  {
    id: 'kimi-k2.5',
    name: 'Kimi K2.5',
    provider: 'moonshot',
    capabilities: ['coding', 'tool-use', 'fast', 'long-context'],
    costPer1MInput: 1.5,
    costPer1MOutput: 7.5,
    maxContext: 131072,
    supportsToolUse: true,
    recommendedRoles: ['worker'],
  },
];

export class KimiProvider implements IModelProvider {
  readonly id = 'moonshot';
  readonly name = 'Moonshot (Kimi)';
  private apiKey: string | null = null;

  isConfigured(): boolean {
    return this.apiKey !== null;
  }

  getModels(): AvailableModel[] {
    return KIMI_MODELS;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  createWorker(modelId: string): IWorkerAgent {
    if (!this.apiKey) {
      throw new Error('Moonshot API key not configured');
    }
    return new KimiWorkerAgent(modelId, this.apiKey);
  }

  async testConnection(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const response = await fetch('https://api.moonshot.cn/v1/models', {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

/**
 * Kimi worker agent — executes tasks via the Moonshot API with a tool-use loop.
 * Uses the OpenAI-compatible chat completions endpoint.
 */
class KimiWorkerAgent implements IWorkerAgent {
  readonly id: string;
  readonly model: string;
  readonly provider = 'moonshot';
  status: 'idle' | 'working' | 'error' = 'idle';

  private apiKey: string;
  private abortController: AbortController | null = null;
  private messages: Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }> = [];

  constructor(model: string, apiKey: string) {
    this.id = `kimi-worker-${randomUUID().slice(0, 8)}`;
    this.model = model;
    this.apiKey = apiKey;
  }

  async *execute(task: WorkerTask, tools: WorkerToolDef[]): AsyncGenerator<WorkerMessage> {
    this.status = 'working';
    this.abortController = new AbortController();

    // Build initial messages
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

    // Convert tools to OpenAI function format
    const openaiTools = tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));

    try {
      // Tool-use loop: keep calling the API until no more tool calls
      let maxIterations = 50; // Safety limit
      while (maxIterations-- > 0) {
        const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
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
          yield { type: 'error', content: `Kimi API error: ${response.status} ${errorText}` };
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
          yield { type: 'error', content: 'No response from Kimi' };
          this.status = 'error';
          return;
        }

        const message = choice.message;

        // If there's text content, yield it
        if (message.content) {
          yield { type: 'text', content: message.content };
        }

        // If there are tool calls, yield them and wait for results
        if (message.tool_calls && message.tool_calls.length > 0) {
          // Add assistant message with tool calls to history
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

            // Tool results will be injected by the orchestration layer
            // For now, yield the tool call and expect results to be added
            // via sendMessage() or direct messages array manipulation
          }
        }

        // If no tool calls, we're done
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
