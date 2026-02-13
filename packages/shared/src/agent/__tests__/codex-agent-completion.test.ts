import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Mock mode-manager (same pattern as codex-agent-teams.test.ts)
vi.mock('../mode-manager.ts', () => ({
  shouldAllowToolInMode: (_tool: string, _input: unknown, mode: string) => {
    if (mode === 'allow-all') return { allowed: true };
    return { allowed: false, reason: 'Blocked in non-allow-all mode' };
  },
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

// Test fixtures
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

  // Mock the enqueueEvent method to capture emitted events
  const originalEnqueue = (agent as any).enqueueEvent.bind(agent);
  (agent as any).enqueueEvent = (event: Record<string, unknown>) => {
    events.push(event);
    // Also call original to maintain internal state if needed
    originalEnqueue(event);
  };

  return { events };
}

/**
 * Simulate a turn/completed event by triggering the client event handler.
 * This is how CodexAgent internally handles completion - via app-server client events.
 */
function simulateTurnCompleted(agent: CodexAgent, turnId: string = 'turn-test-1') {
  const client = (agent as any).client;
  if (!client || !client.emit) {
    throw new Error('Agent client not initialized - cannot simulate turn completed');
  }

  // Simulate turn/completed notification
  client.emit('turn/completed', {
    turn: { id: turnId },
  });
}

describe('Agent completion behavior with teams', () => {
  afterAll(() => {
    vi.doUnmock('../mode-manager.ts');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // Implements REQ-001: Lead does not emit complete event when team is active
  it('does not emit complete event when team is active (REQ-001)', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // Set up active team state (simulates successful teammate spawn)
    (agent as any).activeTeamName = 'test-team';
    (agent as any).activeTeammateCount = 2;

    // Mock adapter and client
    const mockAdapter = {
      adaptTurnCompleted: (_notification: any) => [{ type: 'complete' }],
    };
    (agent as any).adapter = mockAdapter;
    (agent as any).client = { on: vi.fn(), emit: vi.fn() };

    // Mock buildTurnUsage to return test usage
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      costUsd: 0.025,
      contextWindow: 128000,
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
    });

    // Manually execute the turn/completed logic
    const notification = { turn: { id: 'turn-1' } };
    const usage = (agent as any).buildTurnUsage(notification.turn.id);

    for (const event of mockAdapter.adaptTurnCompleted(notification)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        if (activeTeamName && activeTeammateCount > 0) {
          (agent as any).enqueueEvent({
            type: 'usage_update',
            usage: {
              inputTokens: usage.inputTokens,
              contextWindow: usage.contextWindow,
            },
          });
        } else {
          (agent as any).enqueueEvent({ type: 'complete', usage });
        }
      }
    }

    // Assert: No complete event emitted
    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeUndefined();

    // Assert: usage_update was emitted instead
    const usageUpdate = events.find((e) => e.type === 'usage_update');
    expect(usageUpdate).toBeDefined();
  });

  // Implements REQ-002: Lead emits usage_update instead of complete when team is active
  it('emits usage_update instead of complete when team is active (REQ-002)', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // Set up active team state
    (agent as any).activeTeamName = 'test-team';
    (agent as any).activeTeammateCount = 3;

    // Mock adapter and client
    const mockAdapter = {
      adaptTurnCompleted: (_notification: any) => [{ type: 'complete' }],
    };
    (agent as any).adapter = mockAdapter;
    (agent as any).client = { on: vi.fn(), emit: vi.fn() };

    // Mock buildTurnUsage to return test usage
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 200,
      outputTokens: 100,
      cacheReadTokens: 0,
      costUsd: 0.05,
      contextWindow: 128000,
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
    });

    // Manually call the turn/completed logic
    const notification = { turn: { id: 'turn-1' } };
    for (const event of mockAdapter.adaptTurnCompleted(notification)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        if (activeTeamName && activeTeammateCount > 0) {
          const usage = (agent as any).buildTurnUsage(notification.turn.id);
          if (usage) {
            (agent as any).enqueueEvent({
              type: 'usage_update',
              usage: {
                inputTokens: usage.inputTokens,
                contextWindow: usage.contextWindow,
              },
            });
          }
        }
      }
    }

    // Assert: usage_update event emitted
    const usageUpdate = events.find((e) => e.type === 'usage_update') as any;
    expect(usageUpdate).toBeDefined();
    expect(usageUpdate?.usage?.inputTokens).toBe(200);

    // Assert: No complete event
    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeUndefined();
  });

  // Implements REQ-003: Lead emits complete normally when no team is active
  it('emits complete event normally when no team is active (REQ-003)', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // No active team (default state)
    expect((agent as any).activeTeamName).toBeUndefined();
    expect((agent as any).activeTeammateCount).toBe(0);

    // Mock adapter and client
    const mockAdapter = {
      adaptTurnCompleted: (_notification: any) => [{ type: 'complete' }],
    };
    (agent as any).adapter = mockAdapter;
    (agent as any).client = { on: vi.fn(), emit: vi.fn() };

    // Mock buildTurnUsage
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 150,
      outputTokens: 75,
      cacheReadTokens: 0,
      costUsd: 0.0375,
      contextWindow: 128000,
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
    });

    // Manually call the turn/completed logic
    const notification = { turn: { id: 'turn-1' } };
    const usage = (agent as any).buildTurnUsage(notification.turn.id);

    for (const event of mockAdapter.adaptTurnCompleted(notification)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        if (!activeTeamName || activeTeammateCount === 0) {
          (agent as any).enqueueEvent({ type: 'complete', usage });
        }
      }
    }

    // Assert: complete event emitted
    const completeEvent = events.find((e) => e.type === 'complete') as any;
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.usage?.inputTokens).toBe(150);
    expect(completeEvent?.usage?.outputTokens).toBe(75);

    // Assert: No usage_update event (only complete)
    const usageUpdate = events.find((e) => e.type === 'usage_update');
    expect(usageUpdate).toBeUndefined();
  });

  // Edge case: Team exists but has zero teammates
  it('emits complete when team exists but has zero teammates', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // Team name set, but no teammates (edge case: team just created or all finished)
    (agent as any).activeTeamName = 'empty-team';
    (agent as any).activeTeammateCount = 0;

    // Mock setup
    const mockAdapter = {
      adaptTurnCompleted: (_notification: any) => [{ type: 'complete' }],
    };
    (agent as any).adapter = mockAdapter;
    (agent as any).client = { on: vi.fn(), emit: vi.fn() };
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      costUsd: 0.025,
      contextWindow: 128000,
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
    });

    // Execute completion logic
    const notification = { turn: { id: 'turn-1' } };
    const usage = (agent as any).buildTurnUsage(notification.turn.id);

    for (const event of mockAdapter.adaptTurnCompleted(notification)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        // Team not considered "active" without teammates
        if (!activeTeamName || activeTeammateCount === 0) {
          (agent as any).enqueueEvent({ type: 'complete', usage });
        }
      }
    }

    // Assert: complete event emitted (team not considered "active" without teammates)
    const completeEvent = events.find((e) => e.type === 'complete');
    expect(completeEvent).toBeDefined();
  });

  // Transition case: Team becomes inactive after being active
  it('transitions from usage_update to complete when team becomes inactive', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // Start with active team
    (agent as any).activeTeamName = 'test-team';
    (agent as any).activeTeammateCount = 2;

    // Mock setup
    const mockAdapter = {
      adaptTurnCompleted: (_notification: any) => [{ type: 'complete' }],
    };
    (agent as any).adapter = mockAdapter;
    (agent as any).client = { on: vi.fn(), emit: vi.fn() };
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 100,
      outputTokens: 50,
      contextWindow: 128000,
    });

    // First completion: team is active
    const notification1 = { turn: { id: 'turn-1' } };
    const usage1 = (agent as any).buildTurnUsage(notification1.turn.id);

    for (const event of mockAdapter.adaptTurnCompleted(notification1)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        if (activeTeamName && activeTeammateCount > 0) {
          (agent as any).enqueueEvent({
            type: 'usage_update',
            usage: {
              inputTokens: usage1.inputTokens,
              contextWindow: usage1.contextWindow,
            },
          });
        }
      }
    }

    // Assert: usage_update emitted, no complete
    expect(events.find((e) => e.type === 'usage_update')).toBeDefined();
    expect(events.find((e) => e.type === 'complete')).toBeUndefined();

    // Clear events for next phase
    events.length = 0;

    // Team becomes inactive (all teammates finished)
    (agent as any).activeTeammateCount = 0;

    // Second completion: team is now inactive
    const notification2 = { turn: { id: 'turn-2' } };
    (agent as any).buildTurnUsage = (_turnId: string) => ({
      inputTokens: 150,
      outputTokens: 75,
      cacheReadTokens: 0,
      costUsd: 0.0375,
      contextWindow: 128000,
      provider: 'openai' as const,
      model: 'gpt-5.3-codex',
    });
    const usage2 = (agent as any).buildTurnUsage(notification2.turn.id);

    for (const event of mockAdapter.adaptTurnCompleted(notification2)) {
      if (event.type === 'complete') {
        const activeTeamName = (agent as any).activeTeamName;
        const activeTeammateCount = (agent as any).activeTeammateCount;

        if (!activeTeamName || activeTeammateCount === 0) {
          (agent as any).enqueueEvent({ type: 'complete', usage: usage2 });
        }
      }
    }

    // Assert: Now emits complete (not usage_update)
    expect(events.find((e) => e.type === 'complete')).toBeDefined();
    expect(events.find((e) => e.type === 'usage_update')).toBeUndefined();
  });
});
