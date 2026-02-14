# Teammate Health Monitor Audit

## Scope
- apps/electron/src/main/
- packages/

## 1) Where health issues are detected

### Source of detection logic
- `packages/shared/src/agent-teams/health-monitor.ts`
  - `recordActivity(...)` (line ~189): updates last activity, tool-call history, and consecutive error state
  - `recordContextUsage(...)` (line ~240): records capped context usage (0-1)
  - `checkHealth(...)` (line ~278): periodic checks for stall/error-loop/context-exhaustion
  - `checkRetryStorm(...)` (line ~341): detects repeated similar tool calls
  - `emitIssue(...)` (line ~377): debounces + records + emits event

### Detection conditions
- `stall`: teammate has `currentTaskId` and `elapsed > stallTimeoutMs`
- `error-loop`: `consecutiveErrors >= errorLoopThreshold` on same tool
- `retry-storm`: last N calls are same tool with same input prefix (first 100 chars)
- `context-exhaustion`: `contextUsage >= contextWarningThreshold`

## 2) How issues are surfaced/emitted

### Event emission from monitor
- `packages/shared/src/agent-teams/health-monitor.ts`
  - `emitIssue(...)` emits `health:${issue.type}`
  - Stores issue in `state.issues` and debounces by key `teamId:teammateId:type`

### Relay to team lead + dashboard
- `apps/electron/src/main/sessions.ts`
  - `startTeamHealthMonitoring(...)` (line ~1565) calls `healthMonitor.startMonitoring(teamId)`
  - Subscribes to:
    - `health:stall`
    - `health:error-loop`
    - `health:retry-storm`
    - `health:context-exhaustion`
  - Handler sends formatted alert to lead session via `sendMessage(...)`
  - Handler also broadcasts IPC event envelope:
    - channel: `IPC_CHANNELS.AGENT_TEAMS_EVENT`
    - type: `teammate:health_issue`
  - Also sends periodic summary: `### Team Status Check-In` from `getTeamHealth(teamId)`

## 3) Existing methods usable to forward health issues as team events

- `apps/electron/src/main/sessions.ts`
  - Existing path already forwards health issues to team event channel inside `startTeamHealthMonitoring(...)` (`teammate:health_issue`).
  - `emitTeammateToolActivity(...)` (line ~1686) is a reusable IPC broadcast pattern for agent-team dashboard events.
  - Tool lifecycle integration records health inputs at lines ~6687 and ~6701 via `healthMonitor.recordActivity(...)`.

## Relevant code sections to inspect quickly

- `packages/shared/src/agent-teams/health-monitor.ts:278-338` (`checkHealth`)
- `packages/shared/src/agent-teams/health-monitor.ts:341-374` (`checkRetryStorm`)
- `packages/shared/src/agent-teams/health-monitor.ts:377-400` (`emitIssue`)
- `apps/electron/src/main/sessions.ts:1565-1661` (`startTeamHealthMonitoring` + event subscriptions + status check-in)
- `apps/electron/src/main/sessions.ts:1686-1711` (`emitTeammateToolActivity`)
- `apps/electron/src/main/sessions.ts:6682-6712` (feeding `tool_start`/`tool_result` to health monitor)

