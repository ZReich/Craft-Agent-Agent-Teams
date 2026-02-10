# Analysis: Task Tool Success Completion Gating for Agent Teams

**Date**: 2026-02-09
**Requirements**: REQ-001, REQ-003
**Status**: Investigation Complete

## Executive Summary

This analysis identifies where Task tool success triggers completion in the agent implementations and provides recommendations for gating completion when active teams exist. Currently, **ClaudeAgent** has proper gating implemented, while **CodexAgent** lacks this critical behavior.

---

## Requirements Context

**REQ-001**: Lead agent does not emit `complete` event when team is active
**REQ-003**: Lead agent emits `complete` normally when no team is active

### Why This Matters

When a lead agent spawns teammates via the Task tool:
- The lead must stay alive to coordinate teammates and synthesize results
- Premature `complete` events terminate the session before team work finishes
- Without gating, the UI closes the session while teammates are still processing

---

## Current Implementation Analysis

### 1. ClaudeAgent (✅ CORRECT)

**File**: `packages/shared/src/agent/claude-agent.ts`
**Location**: Lines 2573-2589

#### State Tracking
```typescript
// Lines 403-406
private activeTeamName: string | null = null;
private activeTeammateCount: number = 0;
```

#### Spawn Interception (Sets State)
```typescript
// Lines 920-927
// CRITICAL: Set activeTeamName/Count NOW (before returning synthetic result)
// This ensures the keep-alive check at completion time sees an active team.
if (!this.activeTeamName) {
  this.activeTeamName = teamName;
}
this.activeTeammateCount++;

this.onDebug?.(`[AgentTeams] Intercepting teammate spawn: ${teammateName} for team "${teamName}" (count: ${this.activeTeammateCount})`);
```

#### Completion Gating Logic ✅
```typescript
// Lines 2573-2589
if (message.subtype === 'success') {
  // AGENT TEAMS: Don't complete the session if we're managing an active team
  // The lead agent needs to stay alive to coordinate teammates and synthesize results
  if (this.activeTeamName && this.activeTeammateCount > 0) {
    // Team is active - send usage update but keep session running
    // The lead will continue processing and eventually send a message to synthesize results
    this.onDebug?.(`[AgentTeams] Team "${this.activeTeamName}" active with ${this.activeTeammateCount} teammates - keeping session alive`);
    events.push({
      type: 'usage_update',
      usage: {
        inputTokens: usage.inputTokens,
        contextWindow: usage.contextWindow,
      },
    });
  } else {
    // Normal completion - no active team
    events.push({ type: 'complete', usage });
  }
}
```

**Condition**: `this.activeTeamName && this.activeTeammateCount > 0`

#### Behavior
- ✅ **Implements REQ-001**: Blocks `complete` event when team is active
- ✅ **Implements REQ-002**: Emits `usage_update` instead
- ✅ **Implements REQ-003**: Normal completion when no team active
- ✅ **Edge case handling**: Team name alone isn't enough — requires `activeTeammateCount > 0`

---

### 2. CodexAgent (❌ MISSING)

**File**: `packages/shared/src/agent/codex-agent.ts`
**Completion Locations**: Lines 427-441 (turn/completed), Lines 1933-1936 (fallback), Lines 1965-1966 (error)

#### State Tracking: ❌ NONE
```typescript
// Lines 167-266: No activeTeamName or activeTeammateCount properties
```

#### Spawn Interception (No State Tracking)
```typescript
// Lines 1157-1192
if (isSpawnTool && teamName && this.onTeammateSpawnRequested) {
  const teammateName = (inputObj.name as string) || `teammate-${Date.now()}`;
  const prompt = (inputObj.prompt as string) || (inputObj.input as string) || '';
  const model = inputObj.model as string | undefined;

  this.debug(`[AgentTeams] Intercepting teammate spawn: ${teammateName} for team "${teamName}" via MCP`);

  try {
    const result = await this.onTeammateSpawnRequested({
      teamName,
      teammateName,
      prompt,
      model,
    });

    // ❌ NO STATE TRACKING HERE - activeTeamName/Count not set

    // Emits team_initialized event
    this.enqueueEvent({
      type: 'team_initialized',
      teamName,
      teammateName,
      teamToolUseId: itemId,
    });

    // Returns synthetic tool_result
    // Short-circuits actual tool execution
  }
}
```

#### Completion Logic: ❌ NO GATING
```typescript
// Lines 427-441: turn/completed handler
this.client.on('turn/completed', (notification) => {
  const turnId = notification.turn?.id;
  const usage = turnId ? this.buildTurnUsage(turnId) : undefined;
  for (const event of this.adapter.adaptTurnCompleted(notification)) {
    if (event.type === 'complete') {
      // ❌ ALWAYS emits complete - no team check
      this.enqueueEvent({ type: 'complete', usage });
    } else {
      this.enqueueEvent(event);
    }
  }
  if (turnId) this.turnTokenUsage.delete(turnId);
  this.turnComplete = true;
  this.signalEventAvailable(true);
});
```

```typescript
// Lines 1933-1936: Fallback completion in processQuery
// Emit complete if not already emitted
if (!this.turnComplete) {
  // ❌ ALWAYS emits complete - no team check
  yield { type: 'complete' };
}
```

```typescript
// Lines 1965-1966: Error completion
// Emit complete even on error so application knows we're done
// ❌ ALWAYS emits complete - no team check
yield { type: 'complete' };
```

#### Behavior
- ❌ **Violates REQ-001**: Always emits `complete` even when team is active
- ❌ **Risk**: Lead sessions terminate prematurely while teammates are working
- ✅ **Implements REQ-003**: Normal completion when no team (by accident, not design)

---

## Recommendations

### Priority 1: Add State Tracking to CodexAgent (REQ-001)

Add team state properties to CodexAgent class:

```typescript
// File: packages/shared/src/agent/codex-agent.ts
// Location: After line 211 (after turnTokenUsage declaration)

// Agent teams: Track when this agent is acting as a team lead with active teammates
// When true, prevents premature session completion after spawning teammates
private activeTeamName: string | null = null;
private activeTeammateCount: number = 0;
```

### Priority 2: Set State in Spawn Interception

Update the Task tool interception to track spawned teammates:

```typescript
// File: packages/shared/src/agent/codex-agent.ts
// Location: Lines 1157-1192 (in onPreToolUse handler)

if (isSpawnTool && teamName && this.onTeammateSpawnRequested) {
  const teammateName = (inputObj.name as string) || `teammate-${Date.now()}`;
  const prompt = (inputObj.prompt as string) || (inputObj.input as string) || '';
  const model = inputObj.model as string | undefined;

  // 🔧 ADD STATE TRACKING HERE (before async call)
  if (!this.activeTeamName) {
    this.activeTeamName = teamName;
  }
  this.activeTeammateCount++;

  this.debug(`[AgentTeams] Intercepting teammate spawn: ${teammateName} for team "${teamName}" (count: ${this.activeTeammateCount})`);

  try {
    const result = await this.onTeammateSpawnRequested({
      teamName,
      teammateName,
      prompt,
      model,
    });

    // ... rest of existing code
  }
}
```

**Critical Timing**: State MUST be set **before** the async spawn call returns. This ensures the completion handler sees the active team flag even if the turn completes rapidly.

### Priority 3: Gate Completion in turn/completed Handler

Update the turn/completed event handler to check for active teams:

```typescript
// File: packages/shared/src/agent/codex-agent.ts
// Location: Lines 427-441

// Turn completed
this.client.on('turn/completed', (notification) => {
  const turnId = notification.turn?.id;
  const usage = turnId ? this.buildTurnUsage(turnId) : undefined;
  for (const event of this.adapter.adaptTurnCompleted(notification)) {
    if (event.type === 'complete') {
      // 🔧 ADD TEAM GATING HERE
      if (this.activeTeamName && this.activeTeammateCount > 0) {
        // Team is active - send usage update but keep session running
        this.debug(`[AgentTeams] Team "${this.activeTeamName}" active with ${this.activeTeammateCount} teammates - keeping session alive`);
        this.enqueueEvent({
          type: 'usage_update',
          usage: {
            inputTokens: usage?.inputTokens ?? 0,
            contextWindow: usage?.contextWindow,
          },
        });
      } else {
        // Normal completion - no active team
        this.enqueueEvent({ type: 'complete', usage });
      }
    } else {
      this.enqueueEvent(event);
    }
  }
  if (turnId) this.turnTokenUsage.delete(turnId);
  this.turnComplete = true;
  this.signalEventAvailable(true);
});
```

### Priority 4: Gate Fallback Completion

Update the fallback completion in processQuery:

```typescript
// File: packages/shared/src/agent/codex-agent.ts
// Location: Lines 1933-1936

// Emit complete if not already emitted
if (!this.turnComplete) {
  // 🔧 ADD TEAM GATING HERE
  if (this.activeTeamName && this.activeTeammateCount > 0) {
    // Team is active - don't complete yet
    this.debug(`[AgentTeams] Team "${this.activeTeamName}" still active - skipping fallback completion`);
  } else {
    yield { type: 'complete' };
  }
}
```

### Priority 5: Add Team State Reset Method

Add a public method to clear team state (matching ClaudeAgent's API):

```typescript
// File: packages/shared/src/agent/codex-agent.ts
// Location: After constructor

/**
 * Clear active team state (for testing or manual team completion)
 * This allows the session to complete normally on the next result message
 */
public clearTeamState(): void {
  this.activeTeamName = null;
  this.activeTeammateCount = 0;
  this.debug('[AgentTeams] Team state cleared');
}
```

---

## Alternative Approach: AgentTeamManager Integration

Instead of tracking state in each agent, query the centralized AgentTeamManager:

```typescript
// File: packages/shared/src/agent/agent-team-manager.ts
// Location: After line 156

/** Check if a session has an active team with running teammates */
hasActiveTeammates(sessionId: string): boolean {
  for (const team of this.teams.values()) {
    if (team.leadSessionId === sessionId && team.status === 'active') {
      const activeTeammates = team.teammates.filter(t =>
        t.status === 'running' || t.status === 'idle'
      );
      return activeTeammates.length > 0;
    }
  }
  return false;
}
```

Then in agents:

```typescript
// In completion handler
if (this.teamManager?.hasActiveTeammates(this.config.session?.id)) {
  // Keep session alive
  this.enqueueEvent({ type: 'usage_update', usage: { ... } });
} else {
  // Normal completion
  this.enqueueEvent({ type: 'complete', usage });
}
```

**Trade-offs**:
- ✅ **Pro**: Single source of truth (AgentTeamManager)
- ✅ **Pro**: No redundant state tracking in agents
- ❌ **Con**: Requires dependency injection of team manager into agents
- ❌ **Con**: More complex initialization and testing
- ❌ **Con**: Not implemented in existing ClaudeAgent (divergence)

**Recommendation**: Use the **local state approach** (Priority 1-5) for consistency with ClaudeAgent and simpler testing.

---

## Gating Condition Details

### The Condition: `this.activeTeamName && this.activeTeammateCount > 0`

**Why both checks?**

1. **`activeTeamName` check**: Ensures a team was created
2. **`activeTeammateCount > 0` check**: Ensures teammates were actually spawned

**Edge cases handled**:
- Team created but no teammates yet → Allow completion
- All teammates shut down → Allow completion (count decremented to 0)
- Team name set but spawn failed → Allow completion (count never incremented)

### When to Decrement `activeTeammateCount`

The count should be decremented when:
1. A teammate sends a shutdown message
2. A teammate session is terminated
3. A teammate encounters a fatal error

**Implementation location**: Teammate message handlers in agent-team-manager.ts

---

## Testing Requirements

### Unit Tests (REQ-001, REQ-003)

**File**: `packages/shared/src/agent/__tests__/codex-agent-completion.test.ts`

Required test cases:
1. ✅ No complete event when team is active (REQ-001)
2. ✅ Emit usage_update when team is active
3. ✅ Normal completion when no team (REQ-003)
4. ✅ Complete when team exists but has zero teammates
5. ✅ Transition from usage_update to complete when team becomes inactive

See [agent-teams-completion-behavior.md](../test-plans/agent-teams-completion-behavior.md) for full test plan.

### Integration Tests

**Manual testing checklist**:
- [ ] Spawn a team via CodexAgent and verify lead stays alive
- [ ] Send messages to teammates and verify lead processes them
- [ ] Shut down all teammates and verify lead completes normally
- [ ] Start a session without teams and verify immediate completion (regression)
- [ ] Verify UI shows "Team active" indicator correctly

---

## Implementation Checklist

- [ ] Add `activeTeamName` and `activeTeammateCount` properties to CodexAgent
- [ ] Set state in Task tool spawn interception (before async call)
- [ ] Gate completion in `turn/completed` handler
- [ ] Gate fallback completion in `processQuery`
- [ ] Add `clearTeamState()` method
- [ ] Add teammate count decrement logic in message handlers
- [ ] Write unit tests covering all 5 test cases
- [ ] Run manual integration tests
- [ ] Update documentation with new behavior

---

## Files Modified

| File | Changes | Requirements |
|------|---------|--------------|
| `packages/shared/src/agent/codex-agent.ts` | Add state tracking, gate completion | REQ-001, REQ-003 |
| `packages/shared/src/agent/__tests__/codex-agent-completion.test.ts` | New test suite | REQ-001, REQ-003 |
| `packages/shared/src/agent/agent-team-manager.ts` | Optional: Add `hasActiveTeammates()` method | REQ-001 (alternative) |

---

## Risk Assessment

### High Risk: No Gating (Current State)
- Lead sessions terminate prematurely
- Teammates continue working but lead can't synthesize results
- UI shows session as "complete" while work is ongoing
- User loses visibility into team progress

### Low Risk: Gating Implemented
- Lead sessions stay alive properly
- Clean transition from active → complete when team finishes
- Edge cases handled correctly (zero teammates, all shut down)

---

## References

- **Requirements**: [agent-teams-completion-behavior.md](../test-plans/agent-teams-completion-behavior.md)
- **Test Plan**: [agent-teams-completion-behavior.md](../test-plans/agent-teams-completion-behavior.md)
- **ClaudeAgent Implementation**: `packages/shared/src/agent/claude-agent.ts:2573-2589`
- **CodexAgent Turn Handler**: `packages/shared/src/agent/codex-agent.ts:427-441`

---

**Next Steps**: Proceed with Priority 1-5 recommendations to implement gating in CodexAgent.
