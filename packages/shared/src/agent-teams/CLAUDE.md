# Agent Teams Architecture

> **Knowledge base for the agent-teams subsystem.**
> Any agent working on agent-teams features should read this first.
> Keep this document updated when the architecture changes.

## Overview

Agent Teams enables multi-agent orchestration — groups of AI agents collaborating on complex tasks with shared task lists, messaging, quality gates, and health monitoring. The system follows a **5-role hierarchy** with layered quality enforcement.

## Role Hierarchy

```
Lead (session agent) ──→ Head A (teammate) ──→ Worker (subagent)
                    │                     └──→ Reviewer (subagent)
                    ├──→ Head B (teammate) ──→ Worker (subagent)
                    │                     └──→ Reviewer (subagent)
                    └──→ Escalation (teammate)
```

### Roles

Defined in `@craft-agent/core/types` → `agent-teams.ts`:

```typescript
type TeamRole = 'lead' | 'head' | 'worker' | 'reviewer' | 'escalation';
```

| Role | Spawned By | Method | Visibility | Model Config Key |
|------|-----------|--------|------------|-----------------|
| Lead | User | Session start | Dashboard | `leadModel` |
| Head | Lead | Teammate (`team_name` + `role="head"`) | Dashboard | `headModel` |
| Worker | Head | Subagent (Task, NO `team_name`) | Inside Head's context | `workerModel` |
| Reviewer | Head | Subagent (Task, NO `team_name`) | Inside Head's context | `reviewerModel` |
| Escalation | Lead | Teammate (`team_name` + `role="escalation"`) | Dashboard | `escalationModel` |

**Key distinction:** Teammates (Lead, Head, Escalation) are spawned with `team_name` and appear on the dashboard. Subagents (Worker, Reviewer) are spawned by Heads without `team_name` and run invisibly inside the Head's context window.

### Role Inference

In `apps/electron/src/main/sessions.ts`:

```typescript
// Infer from name prefix: "head-california" → head
function inferTeamRoleFromName(teammateName?: string): TeamRole | null
// Priority: explicit role param > name prefix > default (worker)
function normalizeTeamRole(rawRole?: string, teammateName?: string): TeamRole
```

## SDK Integration Architecture

> **How Craft Agent wraps the Claude Agent SDK for agent teams.**
> This section documents the actual interception and routing layer.

### SDK Tools: Interception vs Pass-Through

Craft Agent intercepts several SDK-native team tools in `claude-agent.ts` and
`codex-agent.ts`. The table below shows what happens to each tool call:

| SDK Tool | Intercepted? | What Happens |
|----------|-------------|--------------|
| `Task` (with `team_name`) | **Yes** | Creates a separate `CraftAgent` session via `createTeammateSession()`. Does NOT create a real SDK subprocess teammate. |
| `Task` (without `team_name`) | **No** | Falls through to SDK — creates a native in-process subagent (used by Heads for Workers/Reviewers). |
| `SendMessage` | **Yes** | Routes DMs, broadcasts, and shutdown requests via session manager's `sendMessage()`. |
| `TeamCreate` | **Yes (no-op)** | Intercepted and returns success. Teams are created implicitly when first teammate spawns. |
| `TeamDelete` | **Yes** | Resets agent team state and cleans up `~/.claude/teams/` files. |
| `TaskCreate` | **Not used** | SDK's native task tools are never called. All task management goes through `AgentTeamManager`. |
| `TaskUpdate` | **Not used** | Same — task status transitions happen via `AgentTeamManager.updateTaskStatus()`. |
| `TaskList` | **Not used** | Same — task listing is from `AgentTeamManager.getTasks()`. |
| `TodoWrite` | **Not intercepted** | Used by agents for their own internal tracking, independent of team task management. |

### Teammate Sessions Are NOT SDK Teammates

**Critical architecture detail:** When the lead's `Task` call with `team_name`
is intercepted, Craft Agent creates a **standalone session** (a new `CraftAgent`
instance), not a real SDK team member. This means:

1. The teammate has NO access to SDK's native team tools (`TaskCreate`, `TaskUpdate`, `TaskList`)
2. The teammate communicates only via `SendMessage` (intercepted) and its final assistant output
3. Teammate completion is detected by the session manager's `onProcessingStopped` handler

### Completion Flow

```
Teammate agent finishes processing
  → onProcessingStopped() in sessions.ts
    → handleAgentTeamCompletionOnStop()
      → AgentTeamCompletionCoordinator
        → Checks workspace quality gate config
        → If QG enabled: runs DiffCollector + QualityGateRunner pipeline
          → PASS: relays results to lead, marks task completed, archives
          → FAIL (cycles < max): sends feedback to teammate, teammate retries
          → FAIL (cycles >= max): escalates, relays to lead
        → If QG disabled: relays results directly to lead
```

### State Management

All team state lives in `AgentTeamManager` in-memory Maps:
- `teams`, `tasks`, `messages`, `activityLog` — volatile, reconstructed each session
- `TeamStateStore` — persists tasks, messages, and activity to disk at `sessions/{leadId}/team-state.json`
- SDK's `~/.claude/teams/` and `~/.claude/tasks/` directories are NOT used for state

## Task Domain Routing

File: `routing-policy.ts`

Classifies task prompts into domains and enforces routing rules:

```typescript
type TaskDomain = 'ux_design' | 'frontend' | 'backend' | 'research' | 'search' | 'review' | 'escalation' | 'integration' | 'testing' | 'planning' | 'docs' | 'remediation' | 'rollout_safety' | 'other';
```

| Domain | Default Role | Hard Enforcement |
|--------|-------------|-----------------|
| `ux_design` | `head` | **Always Head + Opus** (REQ-005) |
| `review` | `reviewer` | - |
| `escalation` | `escalation` | - |
| `integration` | `worker` | - |
| `testing` | `worker` | - |
| `planning` | `worker` | - |
| `docs` | `worker` | - |
| `remediation` | `worker` | - |
| `rollout_safety` | `reviewer` | - |
| `frontend` | `worker` | - |
| `backend` | `worker` | - |
| `search` | `worker` | - |
| `research` | `worker` | - |
| `other` | `worker` | - |

Each domain maps to skill slugs via `skillSlugsForDomain()`:
- `ux_design` → `ux-ui-designer`
- `frontend` → `frontend-implementer`
- `backend` → `backend-implementer`
- `search`/`research` → `codebase-cartographer`
- `review` → `quality-reviewer`
- `testing` → `test-writer`
- `integration` → `integration-fixer`
- `planning` → `spec-planner`
- `docs` → `docs-maintainer`
- `remediation` → `remediation-coordinator`
- `rollout_safety` → `rollout-safety-planner`
- `escalation` → `escalation-specialist`

Skill definitions live in `.agents/skills/` at the repo root.

## Quality Gate System

### 10-Stage Pipeline

File: `quality-gates.ts`

Stages execute in this order (stages 3-6 run in parallel, stages 7-9 run in parallel):

| # | Stage | Type | Weight | Description |
|---|-------|------|--------|-------------|
| 1 | `syntax` | Binary | 0 | TypeScript compilation (must pass/fail) |
| 2 | `tests` | Binary | 20 | Test execution (must pass/fail) |
| 3 | `architecture` | Weighted | 25 | Separation of concerns, patterns |
| 4 | `simplicity` | Weighted | 10 | No over-engineering, minimal complexity |
| 5 | `errors` | Weighted | 25 | Error handling, security, crash safety |
| 6 | `completeness` | Weighted | 25 | Requirements coverage, test coverage |
| 7 | `spec_compliance` | Weighted | 20 | SDD mode only — requirement adherence |
| 8 | `traceability` | Weighted | 15 | SDD mode only — REQ-ID tracing |
| 9 | `rollout_safety` | Weighted | 10 | Disabled by default — rollback plans |
| 10 | `design_compliance` | Weighted | 15 | Design Flow only — approved design preserved |

**Binary stages** must score 100 (pass) or 0 (fail) — no partial credit.
**Weighted stages** score 0-100 and contribute to the aggregate via their weights.

### Default Configuration

```typescript
DEFAULT_QUALITY_GATE_CONFIG = {
  enabled: true,
  passThreshold: 90,        // Aggregate score must be >= 90
  maxReviewCycles: 3,        // Max retries before escalation
  enforceTDD: true,
  baselineAwareTests: true,
  knownFailingTests: [],
  testScope: 'affected',     // 'full' | 'affected' | 'none'
  reviewModel: 'claude-opus-4-6',
  escalationModel: 'claude-opus-4-6',
}
```

Pass threshold is clamped to 70-95 range in `mergeQualityGateConfig()`.

### Task Type Inference & QG Skip

Non-code tasks automatically skip quality gates:

```typescript
type TaskType = 'feature' | 'bugfix' | 'refactor' | 'test' | 'docs' | 'research' | 'planning' | 'search' | 'explore' | 'other';

// These skip quality gates:
const NON_CODE_TASK_TYPES = new Set(['research', 'planning', 'search', 'explore', 'docs']);
```

`inferTaskType()` uses keyword patterns on task title/description to auto-classify.

## Review Loop

File: `review-loop.ts`

The `ReviewLoopOrchestrator` connects quality gates to the task completion flow:

### State Machine

```
pending → running → [awaiting-rework ↔ running]* → passed | escalated | failed
```

### Flow

```
1. Teammate marks task "completed"
2. ReviewLoopOrchestrator intercepts → moves to "in_review"
3. Collects diff of teammate's changes
4. Runs 10-stage quality gate pipeline
5a. PASS → marks task truly completed, emits review:passed
5b. FAIL (cycles < max) → sends feedback, returns task to in_progress
5c. FAIL (cycles >= max) → escalates, marks completed after escalation
```

### Key Events

- `review:started` — review cycle begins
- `review:passed` — all stages pass, aggregate >= threshold
- `review:failed` — stages below threshold, feedback sent
- `review:escalated` — max cycles exhausted, escalation triggered
- `review:skipped` — non-code task type, QG bypassed
- `review:queue_full` — queue depth exceeded (max 50)
- `review:remediation-needed` — missing spec requirements detected

### Auto-Remediation

When `spec_compliance` stage fails, the orchestrator extracts missing requirement IDs (REQ-XXX) from the issues and emits `review:remediation-needed` so the lead can create targeted fix tasks.

## Integration Gate

File: `integration-gate.ts`

Runs **after** all individual tasks pass their quality gates. Verifies the combined work:

```typescript
async runCheck(): Promise<IntegrationCheckResult> {
  // 1. TypeScript compilation (full project)     ─┐
  // 2. Git conflict detection                     ─┤ parallel
  // 3. Full test suite (only if typecheck passes) ─┘
  // 4. Wiring verification (new files imported?)
  // 5. Identify breakers via git blame
}
```

### Wiring Verification

Catches the "built but not connected" problem:

1. Collects new files from `git diff --diff-filter=A` + untracked files
2. Filters to code files (.ts/.tsx/.js/.jsx), excludes tests/configs/barrels
3. For each new file, searches for import statements referencing it
4. Files with zero importers are flagged as "unwired" (potential dead code)

## Adaptive Tool Call Throttle

File: `tool-call-throttle.ts`

Proactive congestion control for teammate tool calls, inspired by TCP slow-start / AIMD. Prevents retry storms **before** they happen by limiting how many calls of the same tool type a teammate can make in a sliding window.

### Algorithm

| Phase | Behavior |
|-------|----------|
| **Slow Start** | Budget starts at `initialWindow` (2). Doubles on diverse success until `ssthresh` (8). |
| **Congestion Avoidance** | After ssthresh, budget grows linearly (+1 per diverse success) up to `maxWindow` (15). |
| **Backoff** | When similar calls hit budget, budget halved + 10s cooldown. |
| **Hard Block** | After 3 backoffs in 60s, tool is blocked. Agent must change approach. |

### Configuration

```typescript
interface ThrottleConfig {
  initialWindow: number;      // Default: 2
  ssthresh: number;           // Default: 8
  maxWindow: number;          // Default: 15
  windowDurationMs: number;   // Default: 60_000
  maxBackoffs: number;        // Default: 3
  backoffCooldownMs: number;  // Default: 10_000
}
```

Configurable via `HealthMonitorConfig.throttle` (workspace-level).

### Integration Points

1. **PreToolUse hook** (`claude-agent.ts`): Checks `throttle.check()` before tool execution. Only active for teammate sessions (when `toolCallThrottle` is set on the agent config).
2. **tool_result handler** (`sessions.ts`): Calls `throttle.recordSuccess()` or `throttle.recordFailure()` after execution completes.
3. **Stage 2 enforcement** (`sessions.ts`): Health monitor's `retry-storm-throttle` event now calls `throttle.reset()` to force all budgets back to slow-start.

### Key Design Decisions

- **Per-tool budgets**: An agent doing 5 WebSearches + 5 Reads is healthy research. 15 WebSearches is a storm.
- **Only for teammates**: Team leads don't get throttled (they're user-controlled).
- **Defense in depth**: Throttle prevents most storms. Health monitor catches what slips through.

## Health Monitor

File: `health-monitor.ts`

Periodic health checks (default every 30s) detect four issue types:

| Issue Type | Detection | Default Threshold |
|-----------|-----------|-------------------|
| `stall` | No activity while assigned to task | 5 minutes |
| `error-loop` | Consecutive errors on same tool | 3 errors |
| `retry-storm` | Repeated similar tool calls | 5 calls (10 for research tools) |
| `context-exhaustion` | Context window usage too high | 85% |

Events are debounced (2-minute minimum interval per teammate per issue type).
Issues are stored per-teammate (max 20 retained) and emitted as `health:{type}` events.

### Retry Storm Reset Logic

Retry-storm escalation resets when the agent **changes approach** (different tool or different input), not on every successful tool result. This prevents storms from defeating escalation by succeeding on useless results.

### Partial Result Capture

`recentToolResults` captures the last 20 successful tool result previews (up to 500 chars each). When an agent is auto-killed, these are surfaced to the team lead so partial work isn't fully lost.

## Heartbeat Protocol (REQ-HB-001)

Files: `heartbeat-aggregator.ts`, `model-profiles.ts`

Bidirectional orchestrator ↔ sub-agent communication that runs alongside the health monitor.

### Architecture

```
Sub-Agent Sessions ──(tool calls)──→ HeartbeatAggregator ──(30s batch)──→ UI (IPC)
                                          │                ──(2m summary)──→ Lead LLM
                                          └── Soft Probes ←── (model-aware stall detection)
```

**Design principle:** Observe, don't instruct. We watch tool call patterns at the session layer and synthesize heartbeats — agents are never asked to send heartbeats themselves. Zero token cost for passive monitoring.

### Two-Tier Delivery

| Tier | Interval | Target | Token Cost | Event |
|------|----------|--------|-----------|-------|
| UI heartbeats | 30s (or on significant events) | Renderer via IPC | Zero | `heartbeat:batch` |
| LLM summaries | 2 min | Lead session via `sendMessage` | ~200 tokens | `heartbeat:llm-summary` |

Significant events that trigger early flush: agent completion, error loop detected, context threshold crossed (70%).

### Model-Aware Profiles

Different models have different expected silence periods:

```typescript
// From model-profiles.ts
interface ModelHeartbeatProfile {
  expectedSilenceMs: number;  // Normal thinking time
  softProbeMs: number;        // Send "are you ok?" query
  hardStallMs: number;        // Escalate to health monitor
}
```

Built-in profiles: `claude-haiku` (15s/60s/180s), `claude-sonnet` (30s/90s/300s), `claude-opus` (45s/120s/300s), `gpt-*` (45s/120s/360s), `o1/o3/o4` reasoning (60s/150s/420s).

### Soft Probes (REQ-HB-002)

Before the health monitor's hard stall detection (5 min), the heartbeat aggregator sends a **soft probe** — a lightweight liveness query asking the agent if it's blocked. This recovers many false-positive stalls.

### Activity Classification

Tool call patterns are classified into human-readable summaries:

| Tool Pattern | Summary |
|---|---|
| Read, Grep, Glob | "Exploring codebase" |
| Edit, Write, NotebookEdit | "Implementing changes" |
| WebSearch, WebFetch | "Researching" |
| TodoWrite | "Updating task progress" |
| Task | "Delegating to sub-agent" |
| Bash | "Running commands" |
| No activity > expectedSilenceMs | "Thinking / generating response" |
| No activity > softProbeMs | "May be stalled" |

### Integration Points (sessions.ts)

- **Teammate spawn:** `heartbeatAggregator.registerTeammate()` — registers with model/provider info
- **tool_start events:** `heartbeatAggregator.recordToolCall()` — feeds activity data
- **Teammate completion:** `heartbeatAggregator.signalAgentCompleted()` — triggers immediate UI flush
- **Team cleanup:** `heartbeatAggregator.stopTracking()` — cleans up intervals and state

## YOLO Mode (Autonomous Execution)

File: `yolo-orchestrator.ts`

Drives the full spec → execute → verify lifecycle without manual intervention.

### Phase State Machine

```
idle → spec-generation → task-decomposition → executing → reviewing
  → integration-check → [remediating → executing → ...]* → synthesizing → completed
```

### Modes

- **`smart`** — Adapts at runtime, can propose spec mutations based on discoveries
- **`fixed`** — Follows initial plan without spec changes
- **`off`** — Disabled (default)

### Circuit Breakers

```typescript
DEFAULT_YOLO_CONFIG = {
  costCapUsd: 5.00,              // Auto-pause at $5
  timeoutMinutes: 60,             // Auto-pause at 60 min
  maxConcurrency: 3,              // Max parallel teammates
  maxRemediationRounds: 3,        // Max auto-fix rounds
  requireApprovalForSpecChanges: true,  // Human approval for spec mutations
}
```

### Spec Evolution (Smart Mode)

When quality gates reveal spec gaps, the orchestrator generates `SpecEvolutionProposal` objects. If `requireApprovalForSpecChanges` is true, these are held for human approval before being applied.

## Team Manager

File: `../agent/agent-team-manager.ts`

Central service (`AgentTeamManager`) managing lifecycle, teammates, tasks, and messaging.

### Core Data Stores

```typescript
teams: Map<string, AgentTeam>                    // Active teams
tasks: Map<string, TeamTask[]>                   // Team → task list
messages: Map<string, TeammateMessage[]>          // Team → mailbox
activityLog: Map<string, TeamActivityEvent[]>    // Team → activity feed
teamSpecs: Map<string, Spec>                      // Team → SDD spec
teamPhases: Map<string, TeamPhase[]>              // Team → phase definitions
yoloOrchestrators: Map<string, YoloOrchestrator> // Team → YOLO instance
teamStateStores: Map<string, TeamStateStore>      // Team → persistence
qualityGateResults: Map<string, Map<string, QualityGateResult>>  // Team → per-teammate QG results
taskCompletionContracts: Map<string, Map<string, TaskCompletionContract>> // Team → task → required artifacts
reviewLoop: ReviewLoopOrchestrator | null         // Attached QG pipeline
```

### Completion Contracts (artifact gates)

`AgentTeamManager.createTask()` supports optional completion contracts (`requiredArtifacts`).
When a task is marked `completed`, manager validates that required artifact files exist
(and are non-empty by default). If validation fails, completion is rejected and task is marked `failed`.

This provides deterministic handoff gating for research/planning tasks that skip code quality gates.

### Resource Limits

| Resource | Max | Location |
|----------|-----|----------|
| Activity events per team | 1500 | `AgentTeamManager.MAX_ACTIVITY_EVENTS` |
| Messages per team | 2000 | `AgentTeamManager.MAX_TEAM_MESSAGES` |
| Tasks per team | 3000 | `AgentTeamManager.MAX_TEAM_TASKS` |
| Review queue depth | 50 | `ReviewLoopOrchestrator.MAX_QUEUE_DEPTH` |
| Recent tool calls tracked | 20 | `TeammateHealthMonitor.MAX_RECENT_TOOL_CALLS` |
| Health issue debounce | 2 min | `TeammateHealthMonitor.DEBOUNCE_INTERVAL_MS` |

### Team Lifecycle

```
createTeam() → addTeammate() → [tasks, messages, reviews]* → cleanupTeam()
     │                                                              │
     └── Persisted via TeamStateStore ─────────────────────────────┘
```

State persisted across app restart via `TeamStateStore` (file: `team-state-store.ts`).

Knowledge persistence uses retention guards:
- `team-state-store.ts` prunes stale/expired knowledge entries (TTL + 14-day default window)
- `learning-store.ts` retains rolling quality + knowledge telemetry windows (30-day default)

### Phase-Aware Execution

Tasks can be grouped into phases (`TeamPhase`). Phases execute sequentially; tasks within a phase can run in parallel.

```typescript
interface TeamPhase {
  id: string;
  name: string;
  order: number;          // Lower = earlier
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  taskIds: string[];
}
```

## Configuration

### Workspace Config

File: `../workspaces/types.ts`

```typescript
interface AgentTeamsConfig {
  enabled: boolean;
  modelPreset?: string;  // 'max-quality' | 'balanced' | 'cost-optimized' | 'budget' | 'custom'
  leadModel?: string;
  headModel?: string;
  workerModel?: string;
  reviewerModel?: string;
  escalationModel?: string;
  costCapUsd?: number;
  autoEscalationThreshold?: number;
  qualityGates?: Partial<QualityGateConfig>;
  yolo?: Partial<YoloConfig>;
  memory?: {
    injectionEnabled?: boolean;
    metricsUiEnabled?: boolean;
  };
}
```

Stored in workspace `config.json` under the `agentTeams` key.

### Model Resolution

File: `model-resolution.ts`

Resolution priority:
1. Preset override parameter (from API call)
2. Workspace config `modelPreset`
3. Default preset
4. Per-role overrides from workspace config (`leadModel`, `headModel`, etc.)

```typescript
resolveTeamModelConfig(workspaceConfig, presetOverride?) → ResolvedTeamModelConfig
resolveTeamModelForRole(workspaceConfig, role, presetOverride?, fallback?) → ModelAssignment
```

### Model Presets

```typescript
type ModelPresetId = 'max-quality' | 'balanced' | 'cost-optimized' | 'budget' | 'custom' | 'codex-balanced' | 'codex-full';
```

Each preset assigns model+provider per role. Defined in `../providers/presets.ts`.

## Activity Events

23 event types tracked in the activity feed (13 dead types removed in REQ-CLEANUP-009):

```typescript
type TeamActivityType =
  | 'teammate-spawned' | 'teammate-shutdown'
  | 'task-claimed' | 'task-completed' | 'task-failed' | 'task-in-review'
  | 'quality-gate-passed' | 'quality-gate-failed' | 'review-feedback-sent'
  | 'message-sent' | 'escalation'
  | 'yolo-started' | 'yolo-paused' | 'yolo-completed' | 'yolo-aborted'
  | 'yolo-remediation-created' | 'yolo-spec-evolution-proposed'
  | 'phase-advanced' | 'phase-blocked'
  | 'design-generation-started' | 'design-variant-ready' | 'design-selected'
  | 'error';
```

## Design Patterns

### Event-Driven Coordination

All major components extend `EventEmitter`:
- `AgentTeamManager` — team/teammate/task/activity events
- `ReviewLoopOrchestrator` — review lifecycle events
- `IntegrationGate` — integration check events
- `TeammateHealthMonitor` — health issue events
- `YoloOrchestrator` — phase transition events

### Callback Injection

`ReviewLoopOrchestrator` and `YoloOrchestrator` accept callback interfaces to decouple from concrete implementations. The session layer provides these callbacks to connect the orchestrators to the actual agent runtime.

### Layered Quality Enforcement

```
Individual Task Quality (ReviewLoopOrchestrator)
  → 10-stage pipeline per task
  → Max 3 retry cycles → escalation
    ↓
Team-Level Integration (IntegrationGate)
  → Full project typecheck + test suite
  → Git conflict detection
  → Wiring verification (new files actually imported?)
```

## File Index

| File | Purpose |
|------|---------|
| `quality-gates.ts` | Stage config, score computation, pass/fail logic, failure reports |
| `review-loop.ts` | Review cycle orchestration, retry logic, escalation |
| `integration-gate.ts` | Full-project verification, wiring checks |
| `health-monitor.ts` | Stall/error-loop/retry-storm/context detection + partial result capture |
| `tool-call-throttle.ts` | Adaptive tool call throttle (TCP slow-start / AIMD congestion control) |
| `yolo-orchestrator.ts` | Autonomous execution lifecycle |
| `model-resolution.ts` | Per-role model/provider resolution from presets + config |
| `routing-policy.ts` | Task domain classification, role enforcement |
| `team-state-store.ts` | Team state persistence across app restart |
| `checkpoint-manager.ts` | Git-based checkpoints for rollback |
| `diff-collector.ts` | Collect diffs for quality gate review |
| `file-tracker.ts` | Track file ownership per teammate |
| `audit-logger.ts` | Audit trail for team operations |
| `local-checks.ts` | Cached typecheck/test execution helpers |
| `review-provider.ts` | Provider inference for review models |
| `sdd-exports.ts` | SDD integration exports |

## Related Files Outside This Directory

| File | Purpose |
|------|---------|
| `../agent/agent-team-manager.ts` | Central team lifecycle, tasks, messaging |
| `../agent/claude-agent.ts` | SDK tool interception (Task, SendMessage, TeamCreate, TeamDelete) |
| `../agent/codex-agent.ts` | Codex-mode SDK tool interception (same tools, different agent) |
| `../workspaces/types.ts` | `AgentTeamsConfig` workspace settings |
| `../providers/presets.ts` | Model preset definitions |
| `@craft-agent/core/types/agent-teams.ts` | All shared types (TeamRole, TeamTask, QualityGateResult, etc.) |
| `apps/electron/src/main/sessions.ts` | Session integration, role normalization, spawn handling |
| `apps/electron/src/main/agent-team-completion-coordinator.ts` | Teammate completion → quality gate → relay to lead |
| `apps/electron/src/main/teammate-codenames.ts` | Codename generation for teammates |

## Orchestrator Skill

The agent-team-orchestrator skill (in workspace skills) defines the complete 7-step workflow:

1. **Read config & map models** — resolve workspace `agentTeams` settings
2. **Create team** — `TeamCreate()`
3. **Detect project type** — inject React/Vercel standards if applicable
4. **Adaptive learning** — analyze historical QG scores for weak areas
5. **Generate spec** — requirements + acceptance criteria + Definition of Done
6. **Spawn Heads** — with TDD Worker prompts and 4-stage Reviewer prompts
7. **Monitor, synthesize, deliver** — track completeness, verify wiring, report

See the full skill at: `~/.craft-agent/workspaces/open-claw/skills/agent-team-orchestrator/SKILL.md`

## Maintenance

**When to update this file:**
- Adding/removing quality gate stages
- Changing the role hierarchy or spawning rules
- Modifying the review loop flow or escalation logic
- Adding new activity event types
- Changing configuration schema (AgentTeamsConfig, QualityGateConfig, YoloConfig)
- Adding new files to this directory
