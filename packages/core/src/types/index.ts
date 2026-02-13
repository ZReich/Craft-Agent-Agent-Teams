/**
 * Re-export all types from @craft-agent/core
 */

// Workspace and config types
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
  StoredConfig,
} from './workspace.ts';

// Session types
export type {
  Session,
  StoredSession,
  SessionMetadata,
  SessionStatus,
} from './session.ts';

// Message types
export type {
  MessageRole,
  ToolStatus,
  ToolDisplayMeta,
  AttachmentType,
  MessageAttachment,
  StoredAttachment,
  ContentBadge,
  Message,
  StoredMessage,
  TokenUsage,
  AgentEventUsage,
  RecoveryAction,
  TypedError,
  PermissionRequest,
  AgentEvent,
  // Auth-related types
  CredentialInputMode,
  AuthRequestType,
  AuthStatus,
} from './message.ts';
export { generateMessageId } from './message.ts';

// Agent Teams types
export type {
  AgentTeam,
  AgentTeamStatus,
  AgentTeammate,
  AgentTeammateStatus,
  TeammateTokenUsage,
  TeamTask,
  TeamTaskStatus,
  TeammateMessage,
  TeammateMessageType,
  ModelProvider,
  AvailableModel,
  ModelCapability,
  TeamRole,
  TeamModelConfig,
  ModelAssignment,
  ModelPresetId,
  ModelPreset,
  WorkerTask,
  WorkerMessage,
  ReviewPolicy,
  ReviewResult,
  // Quality Gate types
  QualityGateStageName,
  QualityGateStageResult,
  TestStageResult,
  QualityGateResult,
  QualityGateStageConfig,
  QualityGateConfig,
  TaskType,
  TDDPhase,
  TaskQualityReport,
  TeamActivityEvent,
  TeamActivityType,
  TeamCostSummary,
  // YOLO Mode types
  YoloMode,
  YoloPhase,
  YoloConfig,
  YoloState,
  SpecEvolutionProposal,
  // Phase types
  TeamPhase,
} from './agent-teams.ts';
export { DEFAULT_YOLO_CONFIG } from './agent-teams.ts';

// Team Dashboard View State types (Phase 1)
export type {
  DashboardPanel,
  TaskFilter,
  ActivityFilter,
  TeamDashboardViewState,
  DashboardViewAction,
  TeammateDetailViewState,
  DashboardMetrics,
} from './team-view-state.ts';
export { createInitialDashboardState } from './team-view-state.ts';

// Team Event types (Phase 1)
export type {
  TeamEventEnvelope,
  TeamInitializedEvent,
  TeamUpdatedEvent,
  TeamCleanupEvent,
  TeamCompletedEvent,
  TeammateSpawnedEvent,
  TeammateUpdatedEvent,
  TeammateDeltaEvent,
  TeammateShutdownEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  TaskClaimedEvent,
  TaskCompletedEvent,
  MessageSentEvent,
  MessageBroadcastEvent,
  ActivityLoggedEvent,
  CostUpdatedEvent,
  CostWarningEvent,
  QualityGateStartedEvent,
  QualityGateCompletedEvent,
  IntegrationCheckStartedEvent,
  IntegrationCheckCompletedEvent,
  TeamErrorEvent,
  TeamEvent,
  TeamEventBatch,
} from './team-events.ts';
export {
  createTeamEvent,
  isTeamLifecycleEvent,
  isTeammateEvent,
  isTaskEvent,
  isMessageEvent,
  createEventBatch,
} from './team-events.ts';

// SDD (Spec-Driven Development) types
export type {
  Spec,
  SpecStatus,
  SpecRequirement,
  SpecRisk,
  TicketReference,
  TicketProviderType,
  SpecTemplate,
  SpecTemplateSection,
  DRIAssignment,
  SpecComplianceReport,
  RequirementCoverage,
  TraceabilityEntry,
  RolloutSafetyCheck,
  SDDSessionState,
  SDDQualityGateStageName,
} from './sdd.ts';

// Usage tracking types
export type {
  SessionUsage,
  ProviderUsage,
  TeamSessionUsage,
  WeeklyUsageSummary,
  DailyUsage,
  SessionUsageRef,
  UsageAlertThresholds,
  UsageAlert,
} from './usage-tracking.ts';

