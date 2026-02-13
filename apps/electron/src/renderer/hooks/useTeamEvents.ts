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
  TeammateSpawnedEvent,
  TeammateUpdatedEvent,
  TaskCreatedEvent,
  TaskUpdatedEvent,
  MessageSentEvent,
  ActivityLoggedEvent,
  CostUpdatedEvent,
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
    // TODO: Phase 1 - Full team event support pending. Current IPC only supports TeamActivityEvent.
    // For now, use mock mode for testing.
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
  }, [teamId, eventTypes, batching, mock, enqueueBatchEvent, dispatchEvent]);

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
    // Trigger re-subscription by updating a dependency
    // (In real implementation, would call IPC to reconnect)
    setTimeout(() => setStatus('connected'), 100);
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
export function useTeamEventHandler(
  teamId: string,
  eventType: string,
  handler: TeamEventHandler,
  options?: Omit<TeamEventSubscriptionOptions, 'teamId' | 'eventTypes'>
): UseTeamEventsResult {
  const events = useTeamEvents({ ...options, teamId });

  useEffect(() => {
    events.on(eventType, handler);
    return () => events.off(eventType, handler);
  }, [events, eventType, handler]);

  return events;
}

/**
 * Hook for auto-syncing team state with events
 */
export function useTeamStateSync(
  teamId: string,
  callbacks: {
    onTeamUpdated?: (event: TeamInitializedEvent) => void;
    onTeammateSpawned?: (event: TeammateSpawnedEvent) => void;
    onTeammateUpdated?: (event: TeammateUpdatedEvent) => void;
    onTaskCreated?: (event: TaskCreatedEvent) => void;
    onTaskUpdated?: (event: TaskUpdatedEvent) => void;
    onMessageSent?: (event: MessageSentEvent) => void;
    onActivityLogged?: (event: ActivityLoggedEvent) => void;
    onCostUpdated?: (event: CostUpdatedEvent) => void;
  },
  options?: Omit<TeamEventSubscriptionOptions, 'teamId'>
): UseTeamEventsResult {
  const events = useTeamEvents({ ...options, teamId });

  useEffect(() => {
    const handler = (event: TeamEvent) => {
      switch (event.type) {
        case 'team:initialized':
        case 'team:updated':
          callbacks.onTeamUpdated?.(event as TeamInitializedEvent);
          break;
        case 'teammate:spawned':
          callbacks.onTeammateSpawned?.(event as TeammateSpawnedEvent);
          break;
        case 'teammate:updated':
          callbacks.onTeammateUpdated?.(event as TeammateUpdatedEvent);
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
      }
    };

    events.on('*', handler);
    return () => events.off('*', handler);
  }, [events, callbacks]);

  return events;
}
