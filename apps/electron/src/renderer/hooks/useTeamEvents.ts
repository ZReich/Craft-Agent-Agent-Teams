/**
 * useTeamEvents Hook
 *
 * React hook for subscribing to real-time team events via IPC.
 * Handles event batching, deduplication, and automatic state sync.
 *
 * Phase 1: Event adapter for real-time updates (mock-safe)
 */

import { useEffect, useCallback, useRef, useState } from 'react';
import type {
  TeamEvent,
  TeamEventBatch,
  TeamInitializedEvent,
  TeamCreatedEvent,
  TeamUpdatedEvent,
  TeamCompletedEvent,
  TeamCleanupEvent,
  TeammateSpawnedEvent,
  TeammateUpdatedEvent,
  TeammateShutdownEvent,
  TeammateToolActivityEvent,
  TeammateHealthIssueEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  MessageSentEvent,
  ActivityLoggedEvent,
  CostUpdatedEvent,
  YoloStateChangedEvent,
  SynthesisRequestedEvent,
  HeartbeatBatchEvent,
} from '@craft-agent/core/types';

// ============================================================
// Event Handler Types
// ============================================================

/**
 * Event handler callback signature
 */
export type TeamEventHandler = (event: TeamEvent) => void;

/**
 * Event subscription options
 */
export interface TeamEventSubscriptionOptions {
  /** Team ID to subscribe to */
  teamId: string;

  /** Event types to subscribe to (empty = all events) */
  eventTypes?: string[];

  /** Whether to batch events (default: false) */
  batching?: boolean;

  /** Batch window in milliseconds (default: 100ms) */
  batchWindow?: number;

  /** Enable mock mode for testing (no IPC) */
  mock?: boolean;
}

/**
 * Connection status
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

// ============================================================
// Hook Interface
// ============================================================

export interface UseTeamEventsResult {
  /** Current connection status */
  status: ConnectionStatus;

  /** Last received event */
  lastEvent: TeamEvent | null;

  /** Event sequence number (for ordering) */
  sequence: number;

  /** Subscribe to specific event type */
  on: (eventType: string, handler: TeamEventHandler) => void;

  /** Unsubscribe from event type */
  off: (eventType: string, handler: TeamEventHandler) => void;

  /** Manually trigger reconnection */
  reconnect: () => void;

  /** Check if subscribed to a team */
  isSubscribed: boolean;
}

// ============================================================
// Mock Event Emitter (for testing)
// ============================================================

class MockTeamEventEmitter {
  private handlers = new Map<string, Set<TeamEventHandler>>();

  on(eventType: string, handler: TeamEventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: TeamEventHandler): void {
    this.handlers.get(eventType)?.delete(handler);
  }

  emit(event: TeamEvent): void {
    // Emit to wildcard handlers
    this.handlers.get('*')?.forEach(handler => handler(event));

    // Emit to specific type handlers
    this.handlers.get(event.type)?.forEach(handler => handler(event));
  }

  removeAllListeners(): void {
    this.handlers.clear();
  }
}

// Global mock emitter (singleton for testing)
const mockEmitter = new MockTeamEventEmitter();

/**
 * Expose mock emitter for testing (use in tests to emit mock events)
 */
export function getMockTeamEventEmitter(): MockTeamEventEmitter {
  return mockEmitter;
}

// ============================================================
// Hook Implementation
// ============================================================

/**
 * Hook for subscribing to real-time team events
 *
 * @example
 * ```tsx
 * const { status, on, off } = useTeamEvents({
 *   teamId: 'team-123',
 *   batching: true,
 * });
 *
 * useEffect(() => {
 *   const handler = (event: TeamEvent) => {
 *     console.log('Event received:', event);
 *   };
 *
 *   on('teammate:spawned', handler);
 *   return () => off('teammate:spawned', handler);
 * }, [on, off]);
 * ```
 *
 * @example Mock mode (for testing)
 * ```tsx
 * const { on } = useTeamEvents({ teamId: 'test-team', mock: true });
 *
 * // In tests:
 * import { getMockTeamEventEmitter } from './useTeamEvents';
 * const emitter = getMockTeamEventEmitter();
 * emitter.emit({ type: 'teammate:spawned', ... });
 * ```
 */
export function useTeamEvents(
  options: TeamEventSubscriptionOptions
): UseTeamEventsResult {
  const { teamId, eventTypes, batching = false, batchWindow = 100, mock = false } = options;

  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<TeamEvent | null>(null);
  const [sequence, setSequence] = useState(0);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  // Event handler registry
  const handlersRef = useRef(new Map<string, Set<TeamEventHandler>>());

  // Batch queue (if batching enabled)
  const batchQueueRef = useRef<TeamEvent[]>([]);
  const batchTimerRef = useRef<NodeJS.Timeout | null>(null);

  // ============================================================
  // Event Dispatch
  // ============================================================

  const dispatchEvent = useCallback((event: TeamEvent) => {
    setLastEvent(event);
    setSequence(event.sequence ?? 0);

    // Emit to wildcard handlers
    handlersRef.current.get('*')?.forEach(handler => {
      try {
        handler(event);
      } catch (err) {
        console.error('[useTeamEvents] Handler error:', err);
      }
    });

    // Emit to specific type handlers
    handlersRef.current.get(event.type)?.forEach(handler => {
      try {
        handler(event);
      } catch (err) {
        console.error('[useTeamEvents] Handler error:', err);
      }
    });
  }, []);

  // ============================================================
  // Batch Processing
  // ============================================================

  const processBatch = useCallback(() => {
    if (batchQueueRef.current.length === 0) return;

    const batch = [...batchQueueRef.current];
    batchQueueRef.current = [];

    // Process each event in the batch
    batch.forEach(dispatchEvent);
  }, [dispatchEvent]);

  const enqueueBatchEvent = useCallback((event: TeamEvent) => {
    batchQueueRef.current.push(event);

    // Clear existing timer
    if (batchTimerRef.current) {
      clearTimeout(batchTimerRef.current);
    }

    // Set new timer
    batchTimerRef.current = setTimeout(processBatch, batchWindow);
  }, [processBatch, batchWindow]);

  // ============================================================
  // IPC Event Listener
  // ============================================================

  useEffect(() => {
    if (mock) {
      // Mock mode - use mock emitter
      setStatus('connected');
      setIsSubscribed(true);

      const handler: TeamEventHandler = (event) => {
        if (event.teamId === teamId) {
          if (batching) {
            enqueueBatchEvent(event);
          } else {
            dispatchEvent(event);
          }
        }
      };

      mockEmitter.on('*', handler);

      return () => {
        mockEmitter.off('*', handler);
        setIsSubscribed(false);
      };
    }

    // Real mode - use IPC (if available)
    if (!window.electronAPI?.onAgentTeamEvent) {
      console.warn('[useTeamEvents] Agent team events not available');
      setStatus('error');
      return;
    }

    setStatus('connecting');

    // Subscribe to team events via IPC
    // Note: Currently only TeamActivityEvent is supported via IPC
    const unsubscribe = window.electronAPI.onAgentTeamEvent((event: any) => {
      // Filter by team ID (if event has teamId)
      if (event.teamId && event.teamId !== teamId) return;

      // Filter by event types (if specified)
      if (eventTypes && eventTypes.length > 0 && !eventTypes.includes(event.type)) {
        return;
      }

      // Dispatch or batch
      if (batching) {
        enqueueBatchEvent(event);
      } else {
        dispatchEvent(event);
      }
    });

    setStatus('connected');
    setIsSubscribed(true);

    return () => {
      unsubscribe();
      setIsSubscribed(false);
      setStatus('disconnected');

      // Clear batch timer
      if (batchTimerRef.current) {
        clearTimeout(batchTimerRef.current);
      }
    };
  }, [teamId, eventTypes, batching, mock, enqueueBatchEvent, dispatchEvent, reconnectNonce]);

  // ============================================================
  // Event Subscription API
  // ============================================================

  const on = useCallback((eventType: string, handler: TeamEventHandler) => {
    if (!handlersRef.current.has(eventType)) {
      handlersRef.current.set(eventType, new Set());
    }
    handlersRef.current.get(eventType)!.add(handler);
  }, []);

  const off = useCallback((eventType: string, handler: TeamEventHandler) => {
    handlersRef.current.get(eventType)?.delete(handler);
  }, []);

  const reconnect = useCallback(() => {
    setStatus('connecting');
    setReconnectNonce((prev) => prev + 1);
  }, []);

  // ============================================================
  // Return
  // ============================================================

  return {
    status,
    lastEvent,
    sequence,
    on,
    off,
    reconnect,
    isSubscribed,
  };
}

// ============================================================
// Convenience Hooks
// ============================================================

/**
 * Hook for subscribing to specific event type
 */
// Implements PERF-005: Destructure stable `on`/`off` callbacks (wrapped in useCallback
// with [] deps) so the effect doesn't re-fire on every render. Previously `events`
// (a new object each render) was in the dep array, causing handler thrashing.
export function useTeamEventHandler(
  teamId: string,
  eventType: string,
  handler: TeamEventHandler,
  options?: Omit<TeamEventSubscriptionOptions, 'teamId' | 'eventTypes'>
): UseTeamEventsResult {
  const events = useTeamEvents({ ...options, teamId });
  const { on, off } = events;

  useEffect(() => {
    on(eventType, handler);
    return () => off(eventType, handler);
  }, [on, off, eventType, handler]);

  return events;
}

/**
 * Hook for auto-syncing team state with events
 */
export function useTeamStateSync(
  teamId: string,
  callbacks: {
    onTeamInitialized?: (event: TeamInitializedEvent) => void;
    onTeamCreated?: (event: TeamCreatedEvent) => void;
    onTeamUpdated?: (event: TeamUpdatedEvent) => void;
    onTeamCompleted?: (event: TeamCompletedEvent) => void;
    onTeamCleanup?: (event: TeamCleanupEvent) => void;
    onTeammateSpawned?: (event: TeammateSpawnedEvent) => void;
    onTeammateUpdated?: (event: TeammateUpdatedEvent) => void;
    onTeammateShutdown?: (event: TeammateShutdownEvent) => void;
    onTeammateToolActivity?: (event: TeammateToolActivityEvent) => void;
    onTeammateHealthIssue?: (event: TeammateHealthIssueEvent) => void;
    onTaskCreated?: (event: TaskCreatedEvent) => void;
    onTaskUpdated?: (event: TaskUpdatedEvent) => void;
    onMessageSent?: (event: MessageSentEvent) => void;
    onActivityLogged?: (event: ActivityLoggedEvent) => void;
    onCostUpdated?: (event: CostUpdatedEvent) => void;
    onYoloStateChanged?: (event: YoloStateChangedEvent) => void;
    onSynthesisRequested?: (event: SynthesisRequestedEvent) => void;
    onHeartbeatBatch?: (event: HeartbeatBatchEvent) => void;
  },
  options?: Omit<TeamEventSubscriptionOptions, 'teamId'>
): UseTeamEventsResult {
  const events = useTeamEvents({ ...options, teamId });
  // PERF-005: Destructure stable callbacks to avoid re-subscribing every render
  const { on, off } = events;

  useEffect(() => {
    const handler = (event: TeamEvent) => {
      switch (event.type) {
        case 'team:initialized':
          callbacks.onTeamInitialized?.(event as TeamInitializedEvent);
          break;
        case 'team:created':
          callbacks.onTeamCreated?.(event as TeamCreatedEvent);
          break;
        case 'team:updated':
          callbacks.onTeamUpdated?.(event as TeamUpdatedEvent);
          break;
        case 'team:completed':
          callbacks.onTeamCompleted?.(event as TeamCompletedEvent);
          break;
        case 'team:cleanup':
          callbacks.onTeamCleanup?.(event as TeamCleanupEvent);
          break;
        case 'teammate:spawned':
          callbacks.onTeammateSpawned?.(event as TeammateSpawnedEvent);
          break;
        case 'teammate:updated':
          callbacks.onTeammateUpdated?.(event as TeammateUpdatedEvent);
          break;
        case 'teammate:shutdown':
          callbacks.onTeammateShutdown?.(event as TeammateShutdownEvent);
          break;
        case 'teammate:tool_activity':
          callbacks.onTeammateToolActivity?.(event as TeammateToolActivityEvent);
          break;
        case 'teammate:health_issue':
          callbacks.onTeammateHealthIssue?.(event as TeammateHealthIssueEvent);
          break;
        case 'task:created':
          callbacks.onTaskCreated?.(event as TaskCreatedEvent);
          break;
        case 'task:updated':
          callbacks.onTaskUpdated?.(event as TaskUpdatedEvent);
          break;
        case 'message:sent':
          callbacks.onMessageSent?.(event as MessageSentEvent);
          break;
        case 'activity:logged':
          callbacks.onActivityLogged?.(event as ActivityLoggedEvent);
          break;
        case 'cost:updated':
          callbacks.onCostUpdated?.(event as CostUpdatedEvent);
          break;
        case 'yolo:state_changed':
          callbacks.onYoloStateChanged?.(event as YoloStateChangedEvent);
          break;
        case 'synthesis:requested':
          callbacks.onSynthesisRequested?.(event as SynthesisRequestedEvent);
          break;
        case 'heartbeat:batch':
          callbacks.onHeartbeatBatch?.(event as HeartbeatBatchEvent);
          break;
      }
    };

    on('*', handler);
    return () => off('*', handler);
  }, [on, off, callbacks]);

  return events;
}
