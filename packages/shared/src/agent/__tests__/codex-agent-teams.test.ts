import { describe, it, expect, vi } from 'vitest';

// Mock mode-manager — its transitive dep on incr-regex-package fails under
// Node 22 CJS/ESM interop (incr-regex-package is CJS in packages/shared/node_modules,
// not hoisted to root). We provide a minimal replacement.
vi.mock('../mode-manager.ts', () => ({
  shouldAllowToolInMode: (_tool: string, _input: unknown, mode: string) => {
    if (mode === 'allow-all') return { allowed: true };
    return { allowed: false, reason: 'Blocked in non-allow-all mode' };
  },
  // Implements REQ-001/REQ-002/REQ-005: keep mock export parity with mode-manager contract
  getPermissionMode: vi.fn(() => 'allow-all'),
  setPermissionMode: vi.fn(),
  cyclePermissionMode: vi.fn(() => 'allow-all'),
  isApiEndpointAllowed: vi.fn(() => true),
  getBashRejectionReason: vi.fn(() => null),
  formatBashRejectionMessage: vi.fn((reason: string) => reason),
  PERMISSION_MODE_ORDER: ['safe', 'ask', 'allow-all'],
  PERMISSION_MODE_CONFIG: {},
  SAFE_MODE_CONFIG: {},
}));

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
  agent.setPermissionMode('allow-all');
  return agent;
}

function setupCapture(agent: CodexAgent) {
  const events: Array<Record<string, unknown>> = [];
  const decisions: Record<string, unknown>[] = [];

  (agent as any).enqueueEvent = (event: Record<string, unknown>) => {
    events.push(event);
  };
  (agent as any).safeRespondToPreToolUse = async (_id: string, d: Record<string, unknown>) => {
    decisions.push(d);
  };

  return { events, decisions };
}

async function callPreToolUse(agent: CodexAgent, params: Record<string, unknown>) {
  await (agent as any).handleToolCallPreExecute(params);
}

describe('CodexAgent agent teams interception', () => {
  // ──────────────────────────────────────────────
  // 1. Task spawn via raw toolName (custom type)
  // ──────────────────────────────────────────────
  it('intercepts Task spawn via raw toolName (toolType=custom)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = async (params) => {
      expect(params.teamName).toBe('team-alpha');
      expect(params.teammateName).toBe('Worker');
      expect(params.prompt).toBe('Do work');
      return { sessionId: 'teammate-session-1', agentId: 'teammate-session-1' };
    };

    await callPreToolUse(agent, {
      toolType: 'custom',
      toolName: 'Task',
      input: { team_name: 'team-alpha', name: 'Worker', prompt: 'Do work' },
      requestId: 'req-1',
      itemId: 'item-1',
    });

    // Should block with synthetic result
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('spawned successfully');

    // Should emit team_initialized event
    const teamInit = events.find((e) => e.type === 'team_initialized');
    expect(teamInit).toBeDefined();
    expect(teamInit!.teamName).toBe('team-alpha');
    expect(teamInit!.teammateName).toBe('Worker');

    // Should emit tool_result event
    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'Task');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(String(toolResult!.result)).toContain('Worker');
  });

  // ──────────────────────────────────────────────
  // 2. Task spawn via MCP format (the REAL format)
  // ──────────────────────────────────────────────
  it('intercepts Task spawn via MCP format (toolType=mcp, mcpServer=session)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = async (params) => {
      expect(params.teamName).toBe('team-beta');
      expect(params.teammateName).toBe('Researcher');
      expect(params.prompt).toBe('Research topic');
      expect(params.model).toBe('sonnet');
      return { sessionId: 'teammate-session-2', agentId: 'teammate-session-2' };
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'Task',
      mcpServer: 'session',
      mcpTool: 'Task',
      input: { team_name: 'team-beta', name: 'Researcher', prompt: 'Research topic', model: 'sonnet' },
      requestId: 'req-2',
      itemId: 'item-2',
    });

    // Should block with synthetic result (sdkToolName = 'mcp__session__Task' which endsWith '__Task')
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('spawned successfully');

    // Should emit both events
    const teamInit = events.find((e) => e.type === 'team_initialized');
    expect(teamInit).toBeDefined();
    expect(teamInit!.teamName).toBe('team-beta');
    expect(teamInit!.teammateName).toBe('Researcher');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'Task');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(String(toolResult!.result)).toContain('Researcher');
  });

  // ---------------------------------------------------------------------------
  // 2b. Task spawn without explicit team_name uses fallback (session id)
  // ---------------------------------------------------------------------------
  it('defaults team_name to session id when missing', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = async (params) => {
      expect(params.teamName).toBe('session-test');
      expect(params.teammateName).toBe('Worker');
      expect(params.prompt).toBe('Do work');
      return { sessionId: 'teammate-session-3', agentId: 'teammate-session-3' };
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'Task',
      mcpServer: 'session',
      mcpTool: 'Task',
      input: { name: 'Worker', prompt: 'Do work' },
      requestId: 'req-2b',
      itemId: 'item-2b',
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('spawned successfully');

    const teamInit = events.find((e) => e.type === 'team_initialized');
    expect(teamInit).toBeDefined();
    expect(teamInit!.teamName).toBe('session-test');
    expect(teamInit!.teammateName).toBe('Worker');
  });

  // ──────────────────────────────────────────────
  // 3. SendMessage via raw toolName (custom type)
  // ──────────────────────────────────────────────
  it('routes SendMessage via raw toolName through teammate message callback', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateMessage = async (params) => {
      expect(params.targetName).toBe('Worker');
      expect(params.content).toBe('Hello teammate');
      expect(params.type).toBe('message');
      return { delivered: true };
    };

    await callPreToolUse(agent, {
      toolType: 'custom',
      toolName: 'SendMessage',
      input: { type: 'message', recipient: 'Worker', content: 'Hello teammate' },
      requestId: 'req-3',
      itemId: 'item-3',
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('delivered to "Worker"');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'SendMessage');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(String(toolResult!.result)).toContain('delivered to "Worker"');
  });

  // ──────────────────────────────────────────────
  // 4. SendMessage via MCP format
  // ──────────────────────────────────────────────
  it('routes SendMessage via MCP format through teammate message callback', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateMessage = async (params) => {
      expect(params.targetName).toBe('Researcher');
      expect(params.content).toBe('Status update please');
      expect(params.type).toBe('message');
      return { delivered: true };
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'SendMessage',
      mcpServer: 'session',
      mcpTool: 'SendMessage',
      input: { type: 'message', recipient: 'Researcher', content: 'Status update please' },
      requestId: 'req-4',
      itemId: 'item-4',
    });

    // sdkToolName = 'mcp__session__SendMessage' which endsWith '__SendMessage'
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('delivered to "Researcher"');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'SendMessage');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
  });

  // ──────────────────────────────────────────────
  // 5. TeamCreate via MCP format — success no-op
  // ──────────────────────────────────────────────
  it('intercepts TeamCreate via MCP format and returns success no-op', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    // TeamCreate requires onTeammateSpawnRequested to be set (it checks this as "teams enabled")
    agent.onTeammateSpawnRequested = async () => ({
      sessionId: 'unused',
      agentId: 'unused',
    });

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'TeamCreate',
      mcpServer: 'session',
      mcpTool: 'TeamCreate',
      input: { team_name: 'my-team', description: 'A test team' },
      requestId: 'req-5',
      itemId: 'item-5',
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('Team "my-team" created successfully');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'TeamCreate');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(String(toolResult!.result)).toContain('my-team');
    expect(String(toolResult!.result)).toContain('spawn teammates');
  });

  // ──────────────────────────────────────────────
  // 6. Task spawn error path
  // ──────────────────────────────────────────────
  it('emits error tool_result when onTeammateSpawnRequested throws', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = async () => {
      throw new Error('Session pool exhausted');
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'Task',
      mcpServer: 'session',
      mcpTool: 'Task',
      input: { team_name: 'team-fail', name: 'FailBot', prompt: 'This will fail' },
      requestId: 'req-6',
      itemId: 'item-6',
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('Failed to spawn teammate');
    expect(String(decisions[0]!.reason)).toContain('Session pool exhausted');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'Task');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(true);
    expect(String(toolResult!.result)).toContain('Failed to spawn teammate "FailBot"');
    expect(String(toolResult!.result)).toContain('Session pool exhausted');

    // Should NOT emit team_initialized on error
    const teamInit = events.find((e) => e.type === 'team_initialized');
    expect(teamInit).toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // 7. SendMessage broadcast type
  // ──────────────────────────────────────────────
  it('handles SendMessage broadcast type and reports broadcast to all teammates', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateMessage = async (params) => {
      expect(params.type).toBe('broadcast');
      expect(params.content).toBe('All hands meeting');
      return { delivered: true };
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'SendMessage',
      mcpServer: 'session',
      mcpTool: 'SendMessage',
      input: { type: 'broadcast', content: 'All hands meeting', summary: 'Team announcement' },
      requestId: 'req-7',
      itemId: 'item-7',
    });

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
    expect(String(decisions[0]!.reason)).toContain('broadcast to all teammates');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'SendMessage');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    expect(String(toolResult!.result)).toContain('broadcast to all teammates');
  });

  // ──────────────────────────────────────────────
  // 8. SendMessage shutdown_request type
  // ──────────────────────────────────────────────
  it('handles SendMessage shutdown_request type via onTeammateMessage', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    let receivedParams: { targetName: string; content: string; type: string } | undefined;
    agent.onTeammateMessage = async (params) => {
      receivedParams = params;
      return { delivered: true };
    };

    await callPreToolUse(agent, {
      toolType: 'custom',
      toolName: 'SendMessage',
      input: { type: 'shutdown_request', recipient: 'Worker', content: 'Task complete, shutting down' },
      requestId: 'req-8',
      itemId: 'item-8',
    });

    expect(receivedParams).toBeDefined();
    expect(receivedParams!.type).toBe('shutdown_request');
    expect(receivedParams!.targetName).toBe('Worker');
    expect(receivedParams!.content).toBe('Task complete, shutting down');

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');

    const toolResult = events.find((e) => e.type === 'tool_result' && e.toolName === 'SendMessage');
    expect(toolResult).toBeDefined();
    expect(toolResult!.isError).toBe(false);
    // shutdown_request to a specific recipient reports delivered to that recipient
    expect(String(toolResult!.result)).toContain('delivered to "Worker"');
  });

  // ──────────────────────────────────────────────
  // 9. Task without team_name — should NOT intercept
  // ──────────────────────────────────────────────
  it('intercepts Task when team_name is missing (fallback team id)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    let spawnCalled = false;
    agent.onTeammateSpawnRequested = async () => {
      spawnCalled = true;
      return { sessionId: 'teammate-session-3', agentId: 'teammate-session-3' };
    };

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'Task',
      mcpServer: 'session',
      mcpTool: 'Task',
      input: { prompt: 'Do something without a team', name: 'Solo' },
      requestId: 'req-9',
      itemId: 'item-9',
    });

    expect(spawnCalled).toBe(true);
    expect(events.find((e) => e.type === 'team_initialized')).toBeDefined();
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('block');
  });

  // ──────────────────────────────────────────────
  // 10. Teams disabled (callbacks null) — pass through
  // ──────────────────────────────────────────────
  it('passes through Task tool when teams are disabled (onTeammateSpawnRequested is null)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    // Explicitly ensure callbacks are not set
    agent.onTeammateSpawnRequested = undefined;
    agent.onTeammateMessage = undefined;

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'Task',
      mcpServer: 'session',
      mcpTool: 'Task',
      input: { team_name: 'team-ghost', name: 'Ghost', prompt: 'Nobody home' },
      requestId: 'req-10',
      itemId: 'item-10',
    });

    // Should NOT emit team events
    expect(events.find((e) => e.type === 'team_initialized')).toBeUndefined();
    expect(events.find((e) => e.type === 'tool_result' && e.toolName === 'Task')).toBeUndefined();

    // Should fall through to normal allow
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('allow');
  });

  it('passes through SendMessage tool when teams are disabled (onTeammateMessage is null)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = undefined;
    agent.onTeammateMessage = undefined;

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'SendMessage',
      mcpServer: 'session',
      mcpTool: 'SendMessage',
      input: { type: 'message', recipient: 'Nobody', content: 'Hello?' },
      requestId: 'req-11',
      itemId: 'item-11',
    });

    // Should NOT emit tool_result from agent teams
    expect(events.find((e) => e.type === 'tool_result' && e.toolName === 'SendMessage')).toBeUndefined();

    // Should fall through to normal allow
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('allow');
  });

  it('passes through TeamCreate tool when teams are disabled (onTeammateSpawnRequested is null)', async () => {
    const agent = createAgent();
    const { events, decisions } = setupCapture(agent);

    agent.onTeammateSpawnRequested = undefined;
    agent.onTeammateMessage = undefined;

    await callPreToolUse(agent, {
      toolType: 'mcp',
      toolName: 'TeamCreate',
      mcpServer: 'session',
      mcpTool: 'TeamCreate',
      input: { team_name: 'ghost-team' },
      requestId: 'req-12',
      itemId: 'item-12',
    });

    expect(events.find((e) => e.type === 'tool_result' && e.toolName === 'TeamCreate')).toBeUndefined();
    expect(decisions.length).toBe(1);
    expect(decisions[0]!.type).toBe('allow');
  });
});
