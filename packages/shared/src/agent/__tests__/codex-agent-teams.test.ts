import { describe, it, expect } from 'bun:test';
import { CodexAgent } from '../codex-agent.ts';

const workspace = {
  id: 'ws-test',
  name: 'Test Workspace',
  slug: 'test-workspace',
  rootPath: '/tmp/craft-agent-test',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const session = {
  id: 'session-test',
  workspaceRootPath: '/tmp/craft-agent-test',
  sdkSessionId: undefined,
  createdAt: Date.now(),
  lastUsedAt: Date.now(),
  lastMessageAt: Date.now(),
  workingDirectory: '/tmp/craft-agent-test',
  sdkCwd: '/tmp/craft-agent-test',
  model: 'gpt-5.3-codex',
  llmConnection: 'codex',
};

function createAgent() {
  const agent = new CodexAgent({
    provider: 'openai',
    workspace,
    session,
    model: 'gpt-5.3-codex',
  });

  // Force allow-all to avoid permission gating in tests
  agent.setPermissionMode('allow-all');

  return agent;
}

describe('CodexAgent agent teams interception', () => {
  it('intercepts Task team_name spawns and emits synthetic results', async () => {
    const agent = createAgent();

    const events: Array<Record<string, unknown>> = [];
    (agent as unknown as { enqueueEvent: (event: Record<string, unknown>) => void }).enqueueEvent = (event) => {
      events.push(event);
    };

    let decision: Record<string, unknown> | undefined;
    (agent as unknown as { safeRespondToPreToolUse: (_id: string, d: Record<string, unknown>) => Promise<void> })
      .safeRespondToPreToolUse = async (_id, d) => {
        decision = d;
      };

    agent.onTeammateSpawnRequested = async () => ({
      sessionId: 'teammate-session',
      agentId: 'teammate-session',
    });

    await (agent as unknown as { handleToolCallPreExecute: (params: Record<string, unknown>) => Promise<void> })
      .handleToolCallPreExecute({
        toolType: 'custom',
        toolName: 'Task',
        input: { team_name: 'team-alpha', name: 'Worker', prompt: 'Do work' },
        requestId: 'req-1',
        itemId: 'item-1',
      });

    expect(decision?.type).toBe('block');
    expect(String(decision?.reason)).toContain('Teammate');
    expect(events.some((e) => e.type === 'team_initialized')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.toolName === 'Task')).toBe(true);
  });

  it('routes SendMessage tool calls through teammate message callback', async () => {
    const agent = createAgent();

    const events: Array<Record<string, unknown>> = [];
    (agent as unknown as { enqueueEvent: (event: Record<string, unknown>) => void }).enqueueEvent = (event) => {
      events.push(event);
    };

    let decision: Record<string, unknown> | undefined;
    (agent as unknown as { safeRespondToPreToolUse: (_id: string, d: Record<string, unknown>) => Promise<void> })
      .safeRespondToPreToolUse = async (_id, d) => {
        decision = d;
      };

    agent.onTeammateMessage = async () => ({ delivered: true });

    await (agent as unknown as { handleToolCallPreExecute: (params: Record<string, unknown>) => Promise<void> })
      .handleToolCallPreExecute({
        toolType: 'custom',
        toolName: 'SendMessage',
        input: { type: 'message', recipient: 'Worker', content: 'Hello' },
        requestId: 'req-2',
        itemId: 'item-2',
      });

    expect(decision?.type).toBe('block');
    expect(String(decision?.reason)).toContain('Message');
    expect(events.some((e) => e.type === 'tool_result' && e.toolName === 'SendMessage')).toBe(true);
  });
});
