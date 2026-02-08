# Agent Teams - Remaining Issues

## Current Status

### ✅ What's Working
1. **Env var is set correctly** - `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is being passed to SDK subprocess
2. **Team detection works** - We detect when Task tool has `team_name` parameter
3. **Team initialization events fire** - `team_initialized` events are sent from main → renderer
4. **Session state updates** - `teamId` and `isTeamLead` are set on the session
5. **"Agent Team initializing" messages appear** - Info messages are added to chat

### ❌ What's NOT Working

#### 1. Session Completes Immediately After Spawning Teammates
**Root Cause:** In `packages/shared/src/agent/craft-agent.ts` at lines 2924-2925:

```typescript
if (message.subtype === 'success') {
  events.push({ type: 'complete', usage });
}
```

When the lead agent spawns teammates using the Task tool:
1. Lead calls Task tool 5 times (one per teammate)
2. SDK spawns the teammates and returns tool results immediately
3. SDK sends `result` message with `subtype: 'success'`
4. Code unconditionally emits `complete` event
5. The for-await message loop exits (`craft-agent.ts` line 1606)
6. Lead agent never gets to continue/synthesize results

**Evidence:**
- `~/.claude/teams/` directory is empty (no team config files created)
- `~/.claude/tasks/` directory is empty (no task lists created)
- Teammates are "spawned" but never actually execute (no output, no work done)
- Lead stops processing after the Task tools return success

**The CLI Difference:**
In the CLI, the process stays alive waiting for teammate messages/completions. In our GUI, the session manager calls `onProcessingStopped('complete')` and the lead agent terminates.

#### 2. TeamStatusBar Not Rendering
**Symptom:** User doesn't see the purple team status bar at the top of the chat.

**Possible causes:**
- Session's `teamId` field might not be persisting after the `team_initialized` event
- ChatPage might not be re-rendering after `teamId` is set
- TeamStatusBar component might have a rendering issue

**To debug:**
1. Check if `session.teamId` is actually set in the session atom after event processing
2. Add console.log in ChatPage to see if `session?.teamId` is truthy
3. Verify TeamStatusBar is being imported and rendered conditionally

#### 3. No Teammate Output/Interaction
**Symptom:** User can't see teammate work or interact with them.

**Root Cause:** This is blocked by issue #1 - since teammates never actually start executing (session completes too early), there's no output to display.

**Once teammates execute, we'll need:**
- Parse teammate session IDs from `~/.claude/teams/{team-name}/config.json`
- Stream their stdout/stderr to the UI
- Allow user to send messages to individual teammates
- Show their status (working/idle/planning)

## Solution Path

### Immediate Fix: Keep Lead Agent Alive

The lead agent needs to stay alive after spawning teammates. The SDK's message loop should continue until:
- All teammates have completed their work
- The lead receives and synthesizes results
- The lead explicitly decides the work is done

**Approach 1: Track Active Team State**
Modify the `complete` event emission logic to check if there's an active team:

```typescript
// In craft-agent.ts around line 2924
if (message.subtype === 'success') {
  // Don't emit complete if we're actively managing a team
  // The lead should continue running to coordinate and synthesize
  const hasActiveTeam = /* check if team is active */;
  if (!hasActiveTeam) {
    events.push({ type: 'complete', usage });
  } else {
    // Emit partial usage update but keep processing
    events.push({ type: 'usage_update', usage: {
      inputTokens: usage.inputTokens,
      contextWindow: usage.contextWindow
    }});
  }
}
```

**Approach 2: Wait for Specific Team Completion Signal**
The SDK might send a different message type when a team actually completes. We need to investigate the SDK's team lifecycle.

**Approach 3: Manual Message Send**
After teammates complete, the lead agent might need an explicit message like "All teammates have finished, synthesize their results" to continue processing.

### UI Fixes

Once teammates are actually running:

1. **Fix TeamStatusBar visibility**
   - Debug why it's not rendering
   - Ensure `session.teamId` is set and persisted
   - Add fallback UI if teammates list is empty

2. **Add Teammate Sidebar**
   - Parse team config from `~/.claude/teams/{team-name}/config.json`
   - Create UI component to list teammates
   - Allow clicking to view individual teammate sessions
   - Stream teammate output to dedicated panes

3. **Task List Panel**
   - Read task list from `~/.claude/tasks/{team-name}/`
   - Show pending/in-progress/completed tasks
   - Allow manual task assignment

## Testing Checklist

Once fixed, verify:
- [ ] `~/.claude/teams/{team-name}/config.json` is created
- [ ] `~/.claude/tasks/{team-name}/` contains task files
- [ ] Teammates actually execute and do work
- [ ] TeamStatusBar appears at top of chat
- [ ] Lead agent waits for teammates and synthesizes results
- [ ] Session doesn't complete prematurely

## Resources

- **SDK Docs:** https://code.claude.com/docs/en/agent-teams
- **Team Config Location:** `~/.claude/teams/{team-name}/config.json`
- **Task List Location:** `~/.claude/tasks/{team-name}/`
- **Main Issue:** Session completing before teammates execute
