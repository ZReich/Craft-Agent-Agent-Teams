/**
 * Team Event Envelope Types
 *
 * Minimal JSON event envelopes for real-time team updates.
 * Used for IPC communication between main and renderer processes.
 *
 * Phase 1: Event foundations for adapter hooks
 */

import type {
  AgentTeam,
  AgentTeammate,
  TeamTask,
  TeammateMessage,
  TeamActivityEvent,
  TeamCostSummary,
} from './agent-teams.ts';

// ============================================================
// Event Envelope Structure
// ============================================================

/**
 * Base event envelope with timestamp and team context
 */
export interface TeamEventEnvelope<T = unknown> {
  /** Event type identifier */
  type: string;

  /** Team ID this event belongs to */
  teamId: string;

  /** Event payload */
  payload: T;

  /** Event timestamp (ISO 8601) */
  timestamp: string;

  /** Event sequence number (for ordering) */
  sequence?: number;
}

// ============================================================
// Team Lifecycle Events
// ============================================================

/**
 * Team was initialized (first teammate spawned)
 */
export interface TeamInitializedEvent extends TeamEventEnvelope<{
  team: AgentTeam;
}> {
  type: 'team:initialized';
}

/**
 * Team state was updated
 */
export interface TeamUpdatedEvent extends TeamEventEnvelope<{
  team: AgentTeam;
}> {
  type: 'team:updated';
}

/**
 * Team cleanup started (teammates shutting down)
 */
export interface TeamCleanupEvent extends TeamEventEnvelope<{
  reason?: string;
}> {
  type: 'team:cleanup';
}

/**
 * Team completed (all work done)
 */
export interface TeamCompletedEvent extends TeamEventEnvelope<{
  finalCost: number;
  tasksCompleted: number;
}> {
  type: 'team:completed';
}

// ============================================================
// Teammate Events
// ============================================================

/**
 * New teammate was spawned
 */
export interface TeammateSpawnedEvent extends TeamEventEnvelope<{
  teammate: AgentTeammate;
}> {
  type: 'teammate:spawned';
}

/**
 * Teammate status changed
 */
export interface TeammateUpdatedEvent extends TeamEventEnvelope<{
  teammate: AgentTeammate;
}> {
  type: 'teammate:updated';
}

/**
 * Teammate output delta (streaming work)
 */
export interface TeammateDeltaEvent extends TeamEventEnvelope<{
  teammateId: string;
  delta: string;
  kind: 'text' | 'tool_call' | 'tool_result' | 'thinking';
}> {
  type: 'teammate:delta';
}

/**
 * Teammate shut down
 */
export interface TeammateShutdownEvent extends TeamEventEnvelope<{
  teammateId: string;
  reason?: string;
}> {
  type: 'teammate:shutdown';
}

// ============================================================
// Task Events
// ============================================================

/**
 * New task created
 */
export interface TaskCreatedEvent extends TeamEventEnvelope<{
  task: TeamTask;
}> {
  type: 'task:created';
}

/**
 * Task updated (status, assignee, etc.)
 */
export interface TaskUpdatedEvent extends TeamEventEnvelope<{
  task: TeamTask;
}> {
  type: 'task:updated';
}

/**
 * Task claimed by teammate
 */
export interface TaskClaimedEvent extends TeamEventEnvelope<{
  taskId: string;
  teammateId: string;
  teammateName: string;
}> {
  type: 'task:claimed';
}

/**
 * Task completed
 */
export interface TaskCompletedEvent extends TeamEventEnvelope<{
  taskId: string;
  teammateId: string;
  duration: number; // milliseconds
}> {
  type: 'task:completed';
}

// ============================================================
// Message Events
// ============================================================

/**
 * Message sent between teammates
 */
export interface MessageSentEvent extends TeamEventEnvelope<{
  message: TeammateMessage;
}> {
  type: 'message:sent';
}

/**
 * Broadcast message to all teammates
 */
export interface MessageBroadcastEvent extends TeamEventEnvelope<{
  message: TeammateMessage;
}> {
  type: 'message:broadcast';
}

// ============================================================
// Activity Events
// ============================================================

/**
 * Activity event logged
 */
export interface ActivityLoggedEvent extends TeamEventEnvelope<{
  activity: TeamActivityEvent;
}> {
  type: 'activity:logged';
}

// ============================================================
// Cost Events
// ============================================================

/**
 * Cost summary updated
 */
export interface CostUpdatedEvent extends TeamEventEnvelope<{
  summary: TeamCostSummary;
}> {
  type: 'cost:updated';
}

/**
 * Cost threshold warning
 */
export interface CostWarningEvent extends TeamEventEnvelope<{
  currentCost: number;
  threshold: number;
  message: string;
}> {
  type: 'cost:warning';
}

// ============================================================
// Error Events
// ============================================================

/**
 * Error occurred in team operation
 */
export interface TeamErrorEvent extends TeamEventEnvelope<{
  error: string;
  code?: string;
  teammateId?: string;
  taskId?: string;
}> {
  type: 'team:error';
}

// ============================================================
// Union Type for All Events
// ============================================================

/**
 * All possible team events
 */
export type TeamEvent =
  | TeamInitializedEvent
  | TeamUpdatedEvent
  | TeamCleanupEvent
  | TeamCompletedEvent
  | TeammateSpawnedEvent
  | TeammateUpdatedEvent
  | TeammateDeltaEvent
  | TeammateShutdownEvent
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | TaskClaimedEvent
  | TaskCompletedEvent
  | MessageSentEvent
  | MessageBroadcastEvent
  | ActivityLoggedEvent
  | CostUpdatedEvent
  | CostWarningEvent
  | TeamErrorEvent;

// ============================================================
// Event Factory Functions
// ============================================================

/**
 * Create a team event envelope
 */
export function createTeamEvent<T extends TeamEvent>(
  type: T['type'],
  teamId: string,
  payload: T['payload'],
  sequence?: number
): T {
  return {
    type,
    teamId,
    payload,
    timestamp: new Date().toISOString(),
    sequence,
  } as T;
}

// ============================================================
// Event Type Guards
// ============================================================

/**
 * Type guard for team lifecycle events
 */
export function isTeamLifecycleEvent(event: TeamEvent): event is
  | TeamInitializedEvent
  | TeamUpdatedEvent
  | TeamCleanupEvent
  | TeamCompletedEvent {
  return event.type.startsWith('team:');
}

/**
 * Type guard for teammate events
 */
export function isTeammateEvent(event: TeamEvent): event is
  | TeammateSpawnedEvent
  | TeammateUpdatedEvent
  | TeammateDeltaEvent
  | TeammateShutdownEvent {
  return event.type.startsWith('teammate:');
}

/**
 * Type guard for task events
 */
export function isTaskEvent(event: TeamEvent): event is
  | TaskCreatedEvent
  | TaskUpdatedEvent
  | TaskClaimedEvent
  | TaskCompletedEvent {
  return event.type.startsWith('task:');
}

/**
 * Type guard for message events
 */
export function isMessageEvent(event: TeamEvent): event is
  | MessageSentEvent
  | MessageBroadcastEvent {
  return event.type.startsWith('message:');
}

// ============================================================
// Event Batching
// ============================================================

/**
 * Batch of events (for bulk updates)
 */
export interface TeamEventBatch {
  /** Team ID for all events in this batch */
  teamId: string;

  /** Events in this batch */
  events: TeamEvent[];

  /** Batch timestamp */
  timestamp: string;

  /** Sequence range for this batch */
  sequenceRange: {
    start: number;
    end: number;
  };
}

/**
 * Create an event batch
 */
export function createEventBatch(teamId: string, events: TeamEvent[]): TeamEventBatch {
  return {
    teamId,
    events,
    timestamp: new Date().toISOString(),
    sequenceRange: {
      start: events[0]?.sequence ?? 0,
      end: events[events.length - 1]?.sequence ?? 0,
    },
  };
}
