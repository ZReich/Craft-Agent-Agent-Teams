# Agent Teams Integration Plan

## Problem Analysis

The Claude Agent SDK has experimental agent teams support (enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), but it's designed for CLI/terminal use with tmux panes or in-process mode. We built a complete GUI for agent teams (TeamDashboard, TeammateSidebar, etc.) but didn't wire it up to the SDK's actual team functionality.

**What we built (Phase 1-7):**
- ✅ UI components (TeamDashboard, TeamHeader, TeammateSidebar, TeammateDetailView, etc.)
- ✅ Backend types (AgentTeam, AgentTeammate, TeamTask, etc.)
- ✅ IPC handlers for team operations
- ✅ Settings page for agent teams configuration
- ✅ AgentTeamManager service
- ❌ **Missing:** Integration with SDK's native team tools

**What's actually needed:**
The SDK already handles team coordination. When the agent uses the `Task` tool (called "Agent" in SDK) with `team_name` parameter, it spawns teammates, manages tasks, and handles messaging. We just need to:
1. Detect when the SDK is using team features
2. Display team activity in our GUI instead of terminal output
3. Route inter-teammate messages through our UI

## SDK Agent Teams Architecture

### Native Tools
When `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, the SDK provides:

1. **Task/Agent tool** with team parameters:
   ```typescript
   interface AgentInput {
     prompt: string
     name?: string           // Teammate name
     team_name?: string      // Team identifier
     mode?: "delegate" | "plan" | "default" | ...
   }
   ```

2. **Team coordination:**
   - Team config: `~/.claude/teams/{team-name}/config.json`
   - Task list: `~/.claude/tasks/{team-name}/`
   - Messaging system (mailbox)
   - Automatic status updates

3. **Permission modes:**
   - `delegate`: Restricts lead to coordination-only tools
   - `plan`: Requires plan approval before implementation
   - Others: `default`, `acceptEdits`, `bypassPermissions`, `dontAsk`

### Current Flow (Terminal)
```
User: "Create a team to review the codebase"
 ↓
Lead Agent uses Task tool with team_name="code-review"
 ↓
SDK spawns teammates in tmux panes / in-process
 ↓
Terminal displays teammate output
 ↓
Teammates message each other via SDK mailbox
 ↓
Lead synthesizes results
```

### Desired Flow (GUI)
```
User: "Create a team to review the codebase"
 ↓
Lead Agent uses Task tool with team_name="code-review"
 ↓
We detect team_name in tool call
 ↓
Create team session with TeamDashboard in UI
 ↓
Teammates spawn (SDK handles this)
 ↓
Intercept teammate output → show in TeammateSidebar
 ↓
Show messages in TeammateDetailView
 ↓
Lead synthesizes results in main chat
```

## Integration Strategy

### Phase 1: Tool Interception (Detect Team Usage)

**Goal:** Detect when the SDK is spawning teammates

**Implementation:**
1. In `craft-agent.ts`, intercept `tool_starts` events
2. Check if tool name is "Task" or "Agent" AND has `team_name` parameter
3. Create team session state when first teammate is spawned
4. Send IPC event to renderer: `team_initializing`

**Code Location:**
- `packages/shared/src/agent/craft-agent.ts` - Tool matching logic
- `apps/electron/src/main/sessions.ts` - Session manager to track team state

### Phase 2: Team State Management

**Goal:** Track team membership, tasks, and messages

**Implementation:**
1. Add team fields to `ManagedSession`:
   ```typescript
   interface ManagedSession {
     // ... existing fields
     teamId?: string
     isTeamLead?: boolean
     teammates?: Map<string, TeammateState>
     teamTasks?: TeamTask[]
   }
   ```

2. When teammate is spawned:
   - Parse team config from `~/.claude/teams/{team-name}/config.json`
   - Send `team_member_added` event to renderer
   - Update TeammateSidebar

3. Poll/watch task list at `~/.claude/tasks/{team-name}/`
   - Send `team_task_updated` events
   - Update TaskListPanel

**Code Locations:**
- `apps/electron/src/main/sessions.ts` - Team state tracking
- `apps/electron/src/shared/types.ts` - Team event types

### Phase 3: UI Integration

**Goal:** Display TeamDashboard when team is active

**Implementation:**
1. Modify `ChatDisplay.tsx` to detect team sessions:
   ```typescript
   // If session has teamId, show TeamDashboard
   {session.teamId ? (
     <TeamDashboard
       team={teamData}
       tasks={teamTasks}
       messages={teamMessages}
       onMessage={handleTeammateMessage}
       // ... other props
     />
   ) : (
     // Regular chat display
   )}
   ```

2. Connect AgentTeamManager to IPC:
   - Receive events from main process
   - Update team state in renderer
   - Render in TeamDashboard components

**Code Locations:**
- `apps/electron/src/renderer/components/app-shell/ChatDisplay.tsx`
- `apps/electron/src/renderer/components/teams/TeamDashboard.tsx`

### Phase 4: Teammate Output Streaming

**Goal:** Show teammate work in sidebar instead of terminal

**Implementation:**
1. SDK spawns teammates as separate subprocess
2. Intercept teammate stdout/stderr
3. Parse and send to renderer as `teammate_delta` events
4. Display in TeammateDetailView

**Challenge:** SDK manages teammate processes internally. We may need to:
- Hook into SDK's teammate spawn logic
- Or: Parse SDK's team config to find teammate session IDs
- Or: Use file watching on `~/.claude/teams/{team-name}/config.json`

**Code Locations:**
- `packages/shared/src/agent/craft-agent.ts` - Teammate event interception
- `apps/electron/src/renderer/components/teams/TeammateDetailView.tsx`

### Phase 5: Messaging Integration

**Goal:** Route teammate messages through UI

**Implementation:**
1. Detect message tool calls between teammates
2. Display in TeammateDetailView
3. Allow user to message teammates via UI
4. Send messages using SDK's native messaging

**Code Locations:**
- `apps/electron/src/renderer/components/teams/TeammateDetailView.tsx`
- `packages/shared/src/agent/craft-agent.ts` - Message interception

## Immediate Next Steps

1. **Read SDK team implementation:**
   - Understand how teammates are spawned
   - Find event hooks we can use
   - Identify how to intercept teammate output

2. **Minimal viable integration:**
   - Detect team_name in Task tool calls
   - Show "Agent Team initializing" message
   - Display TeamDashboard when team is active
   - Show teammate count (even if we can't show their output yet)

3. **Incremental enhancement:**
   - Add teammate output streaming
   - Add task list synchronization
   - Add inter-teammate messaging
   - Add review gates for plan approval mode

## Sources
- [Orchestrate teams of Claude Code sessions - Claude Code Docs](https://code.claude.com/docs/en/agent-teams)
- [ForkLog: Claude Opus 4.6 introduces 'Agent Teams'](https://forklog.com/en/claude-opus-4-6-surpasses-gpt-5-2-in-logic-tests-and-introduces-agent-teams/)
- [VentureBeat: Anthropic's Claude Opus 4.6 brings agent teams](https://venturebeat.com/technology/anthropics-claude-opus-4-6-brings-1m-token-context-and-agent-teams-to-take)
- [Anthropic: Introducing Claude Opus 4.6](https://www.anthropic.com/news/claude-opus-4-6)
- [Marco Patzelt: Claude Code Agent Teams Setup Guide](https://www.marc0.dev/en/blog/claude-code-agent-teams-multiple-ai-agents-working-in-parallel-setup-guide-1770317684454)
- [TechCrunch: Anthropic releases Opus 4.6 with new 'agent teams'](https://techcrunch.com/2026/02/05/anthropic-releases-opus-4-6-with-new-agent-teams/)
