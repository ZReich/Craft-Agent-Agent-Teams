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
  TeamActivityEvent,
  TeamActivityType,
  TeamCostSummary,
} from './agent-teams.ts';

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

