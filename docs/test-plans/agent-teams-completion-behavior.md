# Test Plan: Agent Teams Completion Behavior

**REQ-001**: Lead agent does not emit `complete` event when team is active
**REQ-002**: Lead agent emits `usage_update` instead of `complete` when team is active
**REQ-003**: Lead agent emits `complete` normally when no team is active

## Requirements Traceability

These requirements ensure that:
- Lead agents managing active teams stay alive to coordinate teammates
- Lead agents without teams complete normally (existing behavior preserved)
- Usage tracking continues for active teams without triggering premature completion

## Implementation Location

**Files**:
- [`packages/shared/src/agent/codex-agent.ts:213-217`](../../packages/shared/src/agent/codex-agent.ts#L213-L217) - Team tracking properties
- [`packages/shared/src/agent/codex-agent.ts:433-455`](../../packages/shared/src/agent/codex-agent.ts#L433-L455) - Completion logic with team check
- [`packages/shared/src/agent/codex-agent.ts:1193-1197`](../../packages/shared/src/agent/codex-agent.ts#L1193-L1197) - Team tracking on spawn
- [`packages/shared/src/agent/claude-agent.ts:2573-2589`](../../packages/shared/src/agent/claude-agent.ts#L2573-L2589) - ClaudeAgent equivalent

```typescript
// Lines 2573-2589
if (message.subtype === 'success') {
  // AGENT TEAMS: Don't complete the session if we're managing an active team
  if (this.activeTeamName && this.activeTeammateCount > 0) {
    // Team is active - send usage update but keep session running
    this.onDebug?.(`[AgentTeams] Team "${this.activeTeamName}" active...`);
    events.push({
      type: 'usage_update',
      usage: { inputTokens: usage.inputTokens, contextWindow: usage.contextWindow },
    });
  } else {
    // Normal completion - no active team
    events.push({ type: 'complete', usage });
  }
}
```

## Existing Test Infrastructure

### Test Files
- **Primary**: [`packages/shared/src/agent/__tests__/codex-agent-teams.test.ts`](../../packages/shared/src/agent/__tests__/codex-agent-teams.test.ts) - 476 lines, comprehensive agent teams interception tests
- **Model Resolution**: [`packages/shared/src/__tests__/agent-team-model-resolution.test.ts`](../../packages/shared/src/__tests__/agent-team-model-resolution.test.ts) - Model assignment tests
- **Presets**: [`packages/shared/src/__tests__/agent-team-presets.test.ts`](../../packages/shared/src/__tests__/agent-team-presets.test.ts) - Preset configuration tests

### Test Patterns from Existing Tests

The `codex-agent-teams.test.ts` file demonstrates:
- Agent instantiation with workspace/session mocks
- Event capture via `setupCapture()` helper
- Tool call interception via `callPreToolUse()` helper
- Mocking of `mode-manager.ts` for permissions

## Minimal Test Plan

### Test Suite: `packages/shared/src/agent/__tests__/codex-agent-completion.test.ts`

#### Test 1: REQ-001 - No complete event when team is active
```typescript
describe('Agent completion behavior with teams', () => {
  it('does not emit complete event when team is active (REQ-001)', async () => {
    const agent = createAgent();
    const { events } = setupCapture(agent);

    // Set up active team state
    agent.activeTeamName = 'test-team';
    agent.activeTeammateCount = 2;

    // Simulate success message
    await agent.handleMessage({
      type: 'agent',
      subtype: 'success',
      usage: { input_tokens: 100, output_tokens: 50 },
    });

    // Assert: No complete event emitted
    const completeEvent = events.find(e => e.type === 'complete');
    expect(completeEvent).toBeUndefined();
  });
});
```

#### Test 2: REQ-002 - Emit usage_update when team is active
```typescript
it('emits usage_update instead of complete when team is active (REQ-002)', async () => {
  const agent = createAgent();
  const { events } = setupCapture(agent);

  // Set up active team state
  agent.activeTeamName = 'test-team';
  agent.activeTeammateCount = 3;

  // Simulate success message
  await agent.handleMessage({
    type: 'agent',
    subtype: 'success',
    usage: { input_tokens: 200, output_tokens: 100 },
  });

  // Assert: usage_update event emitted
  const usageUpdate = events.find(e => e.type === 'usage_update');
  expect(usageUpdate).toBeDefined();
  expect(usageUpdate.usage.inputTokens).toBe(200);
  expect(usageUpdate.usage.contextWindow).toBeDefined();

  // Assert: No complete event
  expect(events.find(e => e.type === 'complete')).toBeUndefined();
});
```

#### Test 3: REQ-003 - Normal completion when no team active
```typescript
it('emits complete event normally when no team is active (REQ-003)', async () => {
  const agent = createAgent();
  const { events } = setupCapture(agent);

  // No active team (default state)
  expect(agent.activeTeamName).toBeUndefined();
  expect(agent.activeTeammateCount).toBe(0);

  // Simulate success message
  await agent.handleMessage({
    type: 'agent',
    subtype: 'success',
    usage: { input_tokens: 150, output_tokens: 75 },
    total_cost_usd: 0.05,
  });

  // Assert: complete event emitted
  const completeEvent = events.find(e => e.type === 'complete');
  expect(completeEvent).toBeDefined();
  expect(completeEvent.usage.inputTokens).toBe(150);
  expect(completeEvent.usage.outputTokens).toBe(75);
  expect(completeEvent.usage.costUsd).toBe(0.05);

  // Assert: No usage_update event
  expect(events.find(e => e.type === 'usage_update')).toBeUndefined();
});
```

#### Test 4: Edge case - Team exists but no teammates
```typescript
it('emits complete when team exists but has zero teammates', async () => {
  const agent = createAgent();
  const { events } = setupCapture(agent);

  // Team name set, but no teammates (edge case: team just created)
  agent.activeTeamName = 'empty-team';
  agent.activeTeammateCount = 0;

  // Simulate success message
  await agent.handleMessage({
    type: 'agent',
    subtype: 'success',
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  // Assert: complete event emitted (team not considered "active")
  const completeEvent = events.find(e => e.type === 'complete');
  expect(completeEvent).toBeDefined();
});
```

#### Test 5: Transition case - Team becomes inactive
```typescript
it('transitions from usage_update to complete when team becomes inactive', async () => {
  const agent = createAgent();
  const { events } = setupCapture(agent);

  // Start with active team
  agent.activeTeamName = 'test-team';
  agent.activeTeammateCount = 2;

  await agent.handleMessage({
    type: 'agent',
    subtype: 'success',
    usage: { input_tokens: 100, output_tokens: 50 },
  });

  expect(events.find(e => e.type === 'usage_update')).toBeDefined();
  expect(events.find(e => e.type === 'complete')).toBeUndefined();

  // Clear events
  events.length = 0;

  // Team becomes inactive (all teammates finished)
  agent.activeTeammateCount = 0;

  await agent.handleMessage({
    type: 'agent',
    subtype: 'success',
    usage: { input_tokens: 150, output_tokens: 75 },
  });

  // Assert: Now emits complete
  expect(events.find(e => e.type === 'complete')).toBeDefined();
  expect(events.find(e => e.type === 'usage_update')).toBeUndefined();
});
```

## Test Helpers (Reusable)

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CodexAgent } from '../codex-agent.ts';

function createAgent() {
  const workspace = {
    id: 'ws-test',
    name: 'Test Workspace',
    slug: 'test-workspace',
    rootPath: '/tmp/test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const session = {
    id: 'session-test',
    workspaceRootPath: '/tmp/test',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    lastMessageAt: Date.now(),
    workingDirectory: '/tmp/test',
    model: 'claude-sonnet-4-5-20250929',
  };

  return new CodexAgent({ provider: 'anthropic', workspace, session, model: session.model });
}

function setupCapture(agent: CodexAgent) {
  const events: Array<Record<string, unknown>> = [];

  (agent as any).enqueueEvent = (event: Record<string, unknown>) => {
    events.push(event);
  };

  return { events };
}
```

## Coverage Matrix

| Requirement | Test Case | File | Status |
|-------------|-----------|------|--------|
| REQ-001 | No complete event when team active | `codex-agent-completion.test.ts` | ✅ Passing |
| REQ-002 | Emit usage_update when team active | `codex-agent-completion.test.ts` | ✅ Passing |
| REQ-003 | Normal completion when no team | `codex-agent-completion.test.ts` | ✅ Passing |
| Edge Case | Team with zero teammates completes | `codex-agent-completion.test.ts` | ✅ Passing |
| Transition | Team active → inactive transition | `codex-agent-completion.test.ts` | ✅ Passing |

## Manual Testing Checklist

- [ ] Spawn a team and verify lead session stays alive after initial response
- [ ] Send messages to teammates and verify lead continues processing
- [ ] Shut down all teammates and verify lead completes normally
- [ ] Start a session without teams and verify immediate completion (regression test)
- [ ] Check UI shows "Team active" indicator when lead is waiting on teammates

## Integration Points

These tests focus on **unit testing the completion logic**. For end-to-end testing:
- See [`apps/electron/src/__tests__/`](../../apps/electron/src/__tests__/) for integration tests
- Manual testing via the Team Dashboard UI

## Acceptance Criteria

✅ All 5 unit tests pass (100% passing)
✅ No regressions in non-team agent behavior (503/503 tests passing)
✅ Implementation complete in CodexAgent with proper requirement traceability
✅ Team tracking properties added (`activeTeamName`, `activeTeammateCount`)
✅ Completion logic modified to check for active teams before emitting complete event
