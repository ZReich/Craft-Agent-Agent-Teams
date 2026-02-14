/**
 * Agent Teams types for multi-agent orchestration
 *
 * These types define the data model for agent teams — groups of AI agents
 * that collaborate on complex tasks with a shared task list and mailbox.
 */

import type { TicketReference } from './sdd.ts';

// ============================================================
// Team & Teammate Types
// ============================================================

/**
 * An agent team — a group of agents working on a shared objective
 */
export interface AgentTeam {
  id: string;
  name: string;
  /** The session ID of the team lead agent */
  leadSessionId: string;
  /** Current team lifecycle state */
  status: AgentTeamStatus;
  /** When the team was created */
  createdAt: string;
  /** All team members (including lead) */
  members: AgentTeammate[];
  /** Whether delegate mode is active (lead is coordination-only) */
  delegateMode?: boolean;
  /** Model preset used for this team */
  modelPreset?: ModelPresetId;
}

export type AgentTeamStatus = 'active' | 'cleaning-up' | 'completed' | 'error';

/**
 * An individual teammate within a team
 */
export interface AgentTeammate {
  id: string;
  name: string;
  /** Role description (e.g., "frontend specialist", "test engineer") */
  role: string;
  /** SDK agent ID (for Claude teammates) or internal ID (for non-Claude workers) */
  agentId: string;
  /** Session ID for this teammate */
  sessionId: string;
  /** Current activity state */
  status: AgentTeammateStatus;
  /** What the teammate is currently working on */
  currentTask?: string;
  /** Current task ID from the shared task list */
  currentTaskId?: string;
  /** Model being used by this teammate */
  model: string;
  /** Provider for the model */
  provider: string;
  /** Whether this is the team lead */
  isLead?: boolean;
  /** Token usage for this teammate */
  tokenUsage?: TeammateTokenUsage;
}

export type AgentTeammateStatus =
  | 'spawning'
  | 'working'
  | 'idle'
  | 'planning'
  | 'awaiting-approval'
  | 'error'
  | 'shutdown';

/**
 * Token and cost tracking per teammate
 */
export interface TeammateTokenUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// ============================================================
// Task List Types
// ============================================================

/**
 * A task in the shared team task list
 */
export interface TeamTask {
  id: string;
  title: string;
  description?: string;
  status: TeamTaskStatus;
  /** Task type — determines whether quality gates run. Non-code types skip QG. */
  taskType?: TaskType;
  /** Which spec requirements this task addresses */
  requirementIds?: string[];
  /** DRI owner for this task */
  driOwner?: string;
  /** DRI reviewer for this task */
  driReviewer?: string;
  /** Linked ticket references */
  ticketLinks?: TicketReference[];
  /** ID of the teammate assigned to this task */
  assignee?: string;
  /** IDs of tasks that must complete before this one */
  dependencies?: string[];
  /** Phase this task belongs to (for phase-aware execution) */
  phase?: string;
  /** Phase execution order (lower = earlier; tasks in same phase can run in parallel) */
  phaseOrder?: number;
  createdAt: string;
  completedAt?: string;
  /** Who created this task (teammate ID or 'user') */
  createdBy?: string;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'in_review' | 'completed' | 'blocked' | 'failed';

// ============================================================
// Messaging Types
// ============================================================

/**
 * A message between teammates (mailbox system)
 */
export interface TeammateMessage {
  id: string;
  /** Sender teammate ID (or 'user' for user-sent messages) */
  from: string;
  /** Recipient teammate ID (or 'all' for broadcast) */
  to: string;
  content: string;
  timestamp: string;
  type: TeammateMessageType;
}

export type TeammateMessageType = 'message' | 'broadcast' | 'plan-submission' | 'plan-review' | 'escalation';

// ============================================================
// Model Provider Types
// ============================================================

/**
 * A model provider configuration (e.g., Anthropic, Moonshot, OpenRouter)
 */
export interface ModelProvider {
  id: string;
  name: string;
  /** Whether an API key has been configured */
  apiKeyConfigured: boolean;
  /** Available models from this provider */
  models: AvailableModel[];
}

/**
 * An available model from a provider
 */
export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
  /** What this model can do */
  capabilities: ModelCapability[];
  /** Cost per 1M input tokens in USD */
  costPer1MInput: number;
  /** Cost per 1M output tokens in USD */
  costPer1MOutput: number;
  /** Maximum context window in tokens */
  maxContext: number;
  /** Whether this model supports tool/function calling */
  supportsToolUse: boolean;
  /** Recommended roles for this model based on capability/cost */
  recommendedRoles: TeamRole[];
}

export type ModelCapability = 'reasoning' | 'coding' | 'tool-use' | 'fast' | 'vision' | 'long-context';
export type TeamRole = 'lead' | 'head' | 'worker' | 'reviewer' | 'escalation';

/**
 * Model configuration for a team — specifies which model/provider to use per role
 */
export interface TeamModelConfig {
  defaults: {
    lead: ModelAssignment;
    head: ModelAssignment;
    worker: ModelAssignment;
    reviewer: ModelAssignment;
    escalation: ModelAssignment;
  };
  /** Per-teammate model overrides (keyed by teammate ID) */
  perTeammate?: Record<string, ModelAssignment>;
}

export interface ModelAssignment {
  model: string;
  provider: string;
}

// ============================================================
// Model Presets
// ============================================================

export type ModelPresetId =
  | 'max-quality'
  | 'balanced'
  | 'cost-optimized'
  | 'budget'
  | 'custom'
  | 'codex-balanced'
  | 'codex-full';

export interface ModelPreset {
  id: ModelPresetId;
  name: string;
  description: string;
  /** Estimated relative cost indicator */
  costIndicator: '$' | '$$' | '$$$' | '$$$$';
  config: TeamModelConfig;
}

// ============================================================
// Worker Agent Types (for non-Claude models)
// ============================================================

/**
 * A task to be executed by a worker agent
 */
export interface WorkerTask {
  id: string;
  description: string;
  /** Context from the team lead or task list */
  context?: string;
  /** Working directory for file operations */
  workingDirectory?: string;
  /** Available tools for this task */
  allowedTools?: string[];
}

/**
 * Messages streamed from a worker agent during task execution
 */
export interface WorkerMessage {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'complete';
  content: string;
  /** For tool calls */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: string;
}

// ============================================================
// Review Gate Types
// ============================================================

export type ReviewPolicy = 'review-all' | 'review-on-failure' | 'trust';

export interface ReviewResult {
  /** Whether the output was approved */
  approved: boolean;
  /** Feedback from the reviewer */
  feedback?: string;
  /** Whether to escalate to a more capable model */
  escalate?: boolean;
}

// ============================================================
// Quality Gate Types
// ============================================================

/** Names of each quality gate stage */
export type QualityGateStageName = 'syntax' | 'tests' | 'architecture' | 'simplicity' | 'errors' | 'completeness' | 'spec_compliance' | 'traceability' | 'rollout_safety';

/** Result from a single quality gate stage */
export interface QualityGateStageResult {
  score: number; // 0-100
  passed: boolean;
  issues: string[];
  suggestions: string[];
}

/** Test-specific stage result with extra detail */
export interface TestStageResult extends QualityGateStageResult {
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
}

/** Full result from a quality gate pipeline run */
export interface QualityGateResult {
  /** Whether all stages passed and aggregate score meets threshold */
  passed: boolean;
  /** Weighted average score across non-binary stages (0-100) */
  aggregateScore: number;
  /** Per-stage results */
  stages: {
    syntax: QualityGateStageResult;
    tests: TestStageResult;
    architecture: QualityGateStageResult;
    simplicity: QualityGateStageResult;
    errors: QualityGateStageResult;
    completeness: QualityGateStageResult;
    /** SDD stages — only present when a spec is provided */
    spec_compliance?: QualityGateStageResult;
    traceability?: QualityGateStageResult;
    rollout_safety?: QualityGateStageResult;
  };
  /** How many review cycles have run for this task */
  cycleCount: number;
  /** Safety limit for cycles */
  maxCycles: number;
  /** Model used for AI review stages */
  reviewModel: string;
  /** Provider used for AI review stages */
  reviewProvider: string;
  /** If escalation happened, which model was used */
  escalatedTo?: string;
  /** Timestamp of this review run */
  timestamp: string;
}

/** Configuration for a single quality gate stage */
export interface QualityGateStageConfig {
  /** Whether this stage is enabled */
  enabled: boolean;
  /** Weight in the aggregate score (0-100, ignored for binary stages) */
  weight: number;
  /** Binary stages must pass (score 0 or 100) — no partial credit */
  binary?: boolean;
}

/** Quality gate configuration (stored in workspace config) */
export interface QualityGateConfig {
  /** Master toggle for quality gates */
  enabled: boolean;
  /** Minimum aggregate score to pass (default: 90) */
  passThreshold: number;
  /** Maximum review cycles before escalation (default: 3) */
  maxReviewCycles: number;
  /** Whether to enforce test-driven development for feature tasks */
  enforceTDD: boolean;
  /** Model ID for AI review stages (default: 'claude-opus-4-6') */
  reviewModel: string;
  /** Provider for AI review stages (default: 'anthropic') */
  reviewProvider: string;
  /** Model ID for escalation (default: 'claude-opus-4-6') */
  escalationModel: string;
  /** Provider for escalation (default: 'anthropic') */
  escalationProvider: string;
  /** When true, allow suppression of known pre-existing failing tests */
  baselineAwareTests?: boolean;
  /** Known failing tests from baseline (used when baselineAwareTests is enabled) */
  knownFailingTests?: string[];
  /** Test scope for per-task quality gates. 'affected' runs only tests related to changed files (vitest --changed), 'full' runs the entire suite, 'none' skips tests. Default: 'affected' */
  testScope?: 'full' | 'affected' | 'none';
  /** Per-stage configuration */
  stages: Record<QualityGateStageName, QualityGateStageConfig>;
}

/** Task type hint — controls TDD enforcement and quality gate applicability */
export type TaskType = 'feature' | 'bugfix' | 'refactor' | 'test' | 'docs' | 'research' | 'planning' | 'search' | 'explore' | 'other';

/** Task types that produce code and should go through quality gates */
export const CODE_TASK_TYPES: ReadonlySet<TaskType> = new Set(['feature', 'bugfix', 'refactor', 'test']);

/** Task types that are non-code (research, planning, etc.) and should skip quality gates */
export const NON_CODE_TASK_TYPES: ReadonlySet<TaskType> = new Set(['research', 'planning', 'search', 'explore', 'docs']);

/** TDD phase state machine */
export type TDDPhase = 'test-writing' | 'implementing' | 'review';

/** Quality report attached to task completion events */
export interface TaskQualityReport {
  /** The final quality gate result */
  result: QualityGateResult;
  /** History of all review cycles */
  cycleHistory: QualityGateResult[];
  /** Whether this task was escalated */
  wasEscalated: boolean;
  /** Final disposition */
  disposition: 'passed' | 'failed-max-cycles' | 'escalated';
}

// ============================================================
// Team Activity Feed
// ============================================================

export interface TeamActivityEvent {
  id: string;
  timestamp: string;
  type: TeamActivityType;
  /** Owning team ID for this event */
  teamId?: string;
  /** Which teammate triggered this event */
  teammateId?: string;
  teammateName?: string;
  /** Event-specific details */
  details: string;
  /** Related task ID */
  taskId?: string;
}

export type TeamActivityType =
  | 'teammate-spawned'
  | 'teammate-shutdown'
  | 'task-claimed'
  | 'task-completed'
  | 'task-failed'
  | 'task-in-review'
  | 'quality-gate-passed'
  | 'quality-gate-failed'
  | 'review-feedback-sent'
  | 'message-sent'
  | 'plan-submitted'
  | 'plan-approved'
  | 'plan-rejected'
  | 'model-swapped'
  | 'escalation'
  | 'integration-check-started'
  | 'integration-check-passed'
  | 'integration-check-failed'
  | 'stall-detected'
  | 'file-conflict'
  | 'checkpoint-created'
  | 'checkpoint-rollback'
  | 'cost-warning'
  | 'yolo-started'
  | 'yolo-phase-changed'
  | 'yolo-paused'
  | 'yolo-completed'
  | 'yolo-aborted'
  | 'yolo-remediation-created'
  | 'yolo-spec-evolution-proposed'
  | 'phase-advanced'
  | 'phase-blocked'
  | 'error';

// ============================================================
// Cost Tracking
// ============================================================

export interface TeamCostSummary {
  /** Total cost in USD */
  totalCostUsd: number;
  /** Breakdown by teammate */
  perTeammate: Record<string, TeammateTokenUsage>;
  /** Breakdown by model */
  perModel: Record<string, { inputTokens: number; outputTokens: number; costUsd: number }>;
  /** What it would have cost if all agents used Opus */
  allOpusEstimateUsd?: number;
  /** Cost cap (if configured) */
  costCapUsd?: number;
  /** Whether cost cap has been reached */
  costCapReached?: boolean;
}

// ============================================================
// YOLO Mode (Autonomous Execution)
// ============================================================

/** YOLO execution mode */
export type YoloMode = 'smart' | 'fixed' | 'off';

/** Current phase of the YOLO lifecycle state machine */
export type YoloPhase =
  | 'idle'
  | 'spec-generation'
  | 'task-decomposition'
  | 'executing'
  | 'reviewing'
  | 'integration-check'
  | 'remediating'
  | 'synthesizing'
  | 'paused'
  | 'completed'
  | 'aborted';

/**
 * Configuration for YOLO (autonomous) execution mode.
 * Controls how the orchestrator drives the spec → execute → verify loop.
 */
export interface YoloConfig {
  /** Execution mode: 'smart' adapts at runtime, 'fixed' follows the initial plan, 'off' disables */
  mode: YoloMode;
  /** Allow spec mutations during execution based on implementation discoveries (smart only) */
  adaptiveSpecs: boolean;
  /** Maximum total cost in USD before auto-pause */
  costCapUsd: number;
  /** Maximum wall-clock time in minutes before auto-pause */
  timeoutMinutes: number;
  /** Maximum concurrent teammates working in parallel */
  maxConcurrency: number;
  /** Auto-create remediation tasks from quality gate failures */
  autoRemediate: boolean;
  /** Require human approval before spec mutations (smart mode safety net) */
  requireApprovalForSpecChanges: boolean;
  /** Maximum remediation rounds before aborting (prevents infinite loops) */
  maxRemediationRounds: number;
}

/** Sensible defaults for YOLO config */
export const DEFAULT_YOLO_CONFIG: YoloConfig = {
  mode: 'off',
  adaptiveSpecs: true,
  costCapUsd: 5.00,
  timeoutMinutes: 60,
  maxConcurrency: 3,
  autoRemediate: true,
  requireApprovalForSpecChanges: true,
  maxRemediationRounds: 3,
};

/**
 * Runtime state of a YOLO execution — tracks progress through the lifecycle.
 * Persisted on the team so the dashboard can render progress.
 */
export interface YoloState {
  /** Current lifecycle phase */
  phase: YoloPhase;
  /** The objective this run is executing */
  objective: string;
  /** Active YOLO config for this run */
  config: YoloConfig;
  /** When the YOLO run started */
  startedAt: string;
  /** When the YOLO run completed or was aborted */
  completedAt?: string;
  /** Number of remediation rounds executed so far */
  remediationRound: number;
  /** Reason for pause or abort */
  pauseReason?: 'cost-cap' | 'timeout' | 'approval-required' | 'all-teammates-error' | 'max-remediation' | 'user-requested';
  /** Tasks auto-created by remediation (IDs) */
  remediationTaskIds: string[];
  /** Spec evolution proposals pending approval (smart mode) */
  pendingSpecChanges: SpecEvolutionProposal[];
  /** Summary of what happened */
  summary?: string;
}

/**
 * A proposed change to the spec discovered during execution.
 * In smart YOLO mode, these are generated when quality gates reveal spec gaps.
 */
export interface SpecEvolutionProposal {
  id: string;
  /** Which requirement is affected (or 'new' for a new requirement) */
  requirementId: string;
  /** What change is proposed */
  description: string;
  /** Why this change is needed */
  reason: string;
  /** Which teammate discovered this */
  discoveredBy: string;
  /** Which task triggered this discovery */
  sourceTaskId: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
}

// ============================================================
// Phase-Aware Task Grouping
// ============================================================

/**
 * A phase within a team's execution plan.
 * Tasks within a phase can run in parallel; phases execute sequentially.
 */
export interface TeamPhase {
  /** Phase identifier */
  id: string;
  /** Human-readable phase name */
  name: string;
  /** Execution order (lower = earlier) */
  order: number;
  /** Current phase status */
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  /** Task IDs belonging to this phase */
  taskIds: string[];
  /** When this phase completed */
  completedAt?: string;
}
