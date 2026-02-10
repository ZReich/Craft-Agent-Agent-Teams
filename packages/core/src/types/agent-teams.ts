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
  createdAt: string;
  completedAt?: string;
  /** Who created this task (teammate ID or 'user') */
  createdBy?: string;
}

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'failed';

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
  /** Maximum review cycles before escalation (default: 5) */
  maxReviewCycles: number;
  /** Whether to enforce test-driven development for feature tasks */
  enforceTDD: boolean;
  /** Model ID for AI review stages (default: 'kimi-k2.5') */
  reviewModel: string;
  /** Provider for AI review stages (default: 'moonshot') */
  reviewProvider: string;
  /** Model ID for escalation (default: 'claude-sonnet-4-5-20250929') */
  escalationModel: string;
  /** Provider for escalation (default: 'anthropic') */
  escalationProvider: string;
  /** Per-stage configuration */
  stages: Record<QualityGateStageName, QualityGateStageConfig>;
}

/** Task type hint for TDD enforcement */
export type TaskType = 'feature' | 'bugfix' | 'refactor' | 'test' | 'docs' | 'other';

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
  | 'message-sent'
  | 'plan-submitted'
  | 'plan-approved'
  | 'plan-rejected'
  | 'model-swapped'
  | 'escalation'
  | 'cost-warning'
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
