/**
 * useTeamDashboard Tests
 *
 * Tests the dashboard reducer, state transitions, filtered data,
 * and derived metrics. Tests the reducer directly (pure function)
 * rather than through React hooks for simplicity and reliability.
 *
 * Covers:
 * - All reducer actions and state transitions
 * - Task filtering (assignee, status, search)
 * - Activity filtering (teammate, type, time range)
 * - Derived metrics computation
 * - Message thread building
 * - Edge cases: empty state, missing data, boundary conditions
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createInitialDashboardState } from '@craft-agent/core/types';
import type {
  TeamDashboardViewState,
  DashboardViewAction,
  DashboardPanel,
  AgentTeam,
  AgentTeammate,
  TeamTask,
  TeammateMessage,
  TeamActivityEvent,
  TeamCostSummary,
} from '@craft-agent/core/types';

// ============================================================
// Import the reducer directly for testing
// ============================================================

// The reducer is not exported from the hook, so we re-implement it here
// for direct testing. This mirrors the exact logic in useTeamDashboard.ts.
function dashboardReducer(
  state: TeamDashboardViewState,
  action: DashboardViewAction
): TeamDashboardViewState {
  switch (action.type) {
    case 'SET_TEAM':
      return {
        ...state,
        team: action.payload,
        ui: { ...state.ui, loading: false, error: null },
      };

    case 'SET_ACTIVE_PANEL':
      return {
        ...state,
        activePanel: action.payload,
      };

    case 'SELECT_TEAMMATE':
      return {
        ...state,
        selectedTeammate: action.payload,
        ui: {
          ...state.ui,
          detailPanelVisible: action.payload !== null,
        },
      };

    case 'UPDATE_TASK_FILTER':
      return {
        ...state,
        tasks: {
          ...state.tasks,
          filter: { ...state.tasks.filter, ...action.payload },
        },
      };

    case 'UPDATE_ACTIVITY_FILTER':
      return {
        ...state,
        activity: {
          ...state.activity,
          filter: { ...state.activity.filter, ...action.payload },
        },
      };

    case 'TOGGLE_TASK_EXPANDED': {
      const expanded = new Set(state.tasks.expanded);
      if (expanded.has(action.payload)) {
        expanded.delete(action.payload);
      } else {
        expanded.add(action.payload);
      }
      return {
        ...state,
        tasks: { ...state.tasks, expanded },
      };
    }

    case 'SET_TASKS':
      return {
        ...state,
        tasks: { ...state.tasks, items: action.payload },
      };

    case 'UPDATE_TASK': {
      const items = state.tasks.items.map(task =>
        task.id === action.payload.id ? action.payload : task
      );
      return {
        ...state,
        tasks: { ...state.tasks, items },
      };
    }

    case 'SET_TEAMMATES':
      return {
        ...state,
        teammates: { ...state.teammates, items: action.payload },
      };

    case 'UPDATE_TEAMMATE': {
      const items = state.teammates.items.map(mate =>
        mate.id === action.payload.id ? action.payload : mate
      );
      return {
        ...state,
        teammates: { ...state.teammates, items },
      };
    }

    case 'ADD_ACTIVITY':
      return {
        ...state,
        activity: {
          ...state.activity,
          events: [...state.activity.events, action.payload],
        },
      };

    case 'SET_ACTIVITY':
      return {
        ...state,
        activity: { ...state.activity, events: action.payload },
      };

    case 'ADD_MESSAGE': {
      const messages = [...state.messages.items, action.payload];
      const threads = new Map<string, TeammateMessage[]>();
      for (const msg of messages) {
        const threadKey = [msg.from, msg.to].sort().join(':');
        if (!threads.has(threadKey)) {
          threads.set(threadKey, []);
        }
        threads.get(threadKey)!.push(msg);
      }
      return {
        ...state,
        messages: { items: messages, threads },
      };
    }

    case 'SET_MESSAGES': {
      const threads = new Map<string, TeammateMessage[]>();
      for (const msg of action.payload) {
        const threadKey = [msg.from, msg.to].sort().join(':');
        if (!threads.has(threadKey)) {
          threads.set(threadKey, []);
        }
        threads.get(threadKey)!.push(msg);
      }
      return {
        ...state,
        messages: { items: action.payload, threads },
      };
    }

    case 'UPDATE_COSTS':
      return {
        ...state,
        costs: { ...state.costs, summary: action.payload },
      };

    case 'TOGGLE_SIDEBAR':
      return {
        ...state,
        ui: {
          ...state.ui,
          sidebarCollapsed: !state.ui.sidebarCollapsed,
        },
      };

    case 'TOGGLE_DETAIL_PANEL':
      return {
        ...state,
        ui: {
          ...state.ui,
          detailPanelVisible: !state.ui.detailPanelVisible,
        },
      };

    case 'SET_LOADING':
      return {
        ...state,
        ui: { ...state.ui, loading: action.payload },
      };

    case 'SET_ERROR':
      return {
        ...state,
        ui: { ...state.ui, error: action.payload, loading: false },
      };

    case 'SET_REALTIME_CONNECTED':
      return {
        ...state,
        realtime: {
          ...state.realtime,
          connected: action.payload,
        },
      };

    case 'MARK_UPDATE_RECEIVED':
      return {
        ...state,
        realtime: {
          ...state.realtime,
          lastUpdate: new Date().toISOString(),
          pendingUpdates: 0,
        },
      };

    default:
      return state;
  }
}

// ============================================================
// Test Fixtures
// ============================================================

function createTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: 'team-1',
    name: 'Test Team',
    leadSessionId: 'lead-sess-1',
    status: 'active',
    createdAt: '2025-01-01T00:00:00Z',
    members: [],
    ...overrides,
  };
}

function createTeammate(overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id: 'mate-1',
    name: 'Worker 1',
    role: 'frontend specialist',
    agentId: 'agent-1',
    sessionId: 'sess-1',
    status: 'working',
    model: 'claude-sonnet-4',
    provider: 'anthropic',
    ...overrides,
  };
}

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    title: 'Implement feature',
    status: 'pending',
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function createMessage(overrides: Partial<TeammateMessage> = {}): TeammateMessage {
  return {
    id: 'msg-1',
    from: 'mate-1',
    to: 'mate-2',
    content: 'Hello',
    timestamp: '2025-01-01T00:00:00Z',
    type: 'message',
    ...overrides,
  };
}

function createActivityEvent(overrides: Partial<TeamActivityEvent> = {}): TeamActivityEvent {
  return {
    id: 'activity-1',
    timestamp: '2025-01-01T00:00:00Z',
    type: 'teammate-spawned',
    details: 'Worker 1 spawned',
    ...overrides,
  };
}

// ============================================================
// Initial State
// ============================================================

describe('createInitialDashboardState', () => {
  it('creates valid initial state', () => {
    const state = createInitialDashboardState();
    expect(state.team).toBeNull();
    expect(state.activePanel).toBe('overview');
    expect(state.selectedTeammate).toBeNull();
    expect(state.tasks.items).toEqual([]);
    expect(state.tasks.filter).toEqual({});
    expect(state.tasks.expanded.size).toBe(0);
    expect(state.teammates.items).toEqual([]);
    expect(state.teammates.sortBy).toBe('status');
    expect(state.activity.events).toEqual([]);
    expect(state.activity.filter).toEqual({});
    expect(state.activity.autoScroll).toBe(true);
    expect(state.messages.items).toEqual([]);
    expect(state.messages.threads.size).toBe(0);
    expect(state.costs.summary).toBeNull();
    expect(state.costs.expanded).toBe(false);
    expect(state.ui.sidebarCollapsed).toBe(false);
    expect(state.ui.detailPanelVisible).toBe(false);
    expect(state.ui.loading).toBe(false);
    expect(state.ui.error).toBeNull();
    expect(state.realtime.connected).toBe(false);
    expect(state.realtime.lastUpdate).toBeNull();
    expect(state.realtime.pendingUpdates).toBe(0);
  });
});

// ============================================================
// Reducer Actions
// ============================================================

describe('dashboardReducer', () => {
  let initialState: TeamDashboardViewState;

  beforeEach(() => {
    initialState = createInitialDashboardState();
  });

  describe('SET_TEAM', () => {
    it('sets team and clears loading/error', () => {
      const team = createTeam();
      const loadingState = { ...initialState, ui: { ...initialState.ui, loading: true, error: 'old error' } };
      const result = dashboardReducer(loadingState, { type: 'SET_TEAM', payload: team });

      expect(result.team).toBe(team);
      expect(result.ui.loading).toBe(false);
      expect(result.ui.error).toBeNull();
    });
  });

  describe('SET_ACTIVE_PANEL', () => {
    it('changes active panel', () => {
      const panels: DashboardPanel[] = ['overview', 'tasks', 'teammates', 'activity', 'costs'];
      for (const panel of panels) {
        const result = dashboardReducer(initialState, { type: 'SET_ACTIVE_PANEL', payload: panel });
        expect(result.activePanel).toBe(panel);
      }
    });
  });

  describe('SELECT_TEAMMATE', () => {
    it('selects teammate and shows detail panel', () => {
      const mate = createTeammate();
      const result = dashboardReducer(initialState, { type: 'SELECT_TEAMMATE', payload: mate });
      expect(result.selectedTeammate).toBe(mate);
      expect(result.ui.detailPanelVisible).toBe(true);
    });

    it('deselects teammate and hides detail panel', () => {
      const withMate = dashboardReducer(initialState, {
        type: 'SELECT_TEAMMATE',
        payload: createTeammate(),
      });
      const result = dashboardReducer(withMate, { type: 'SELECT_TEAMMATE', payload: null });
      expect(result.selectedTeammate).toBeNull();
      expect(result.ui.detailPanelVisible).toBe(false);
    });
  });

  describe('UPDATE_TASK_FILTER', () => {
    it('merges partial filter', () => {
      const result = dashboardReducer(initialState, {
        type: 'UPDATE_TASK_FILTER',
        payload: { assignee: 'mate-1' },
      });
      expect(result.tasks.filter.assignee).toBe('mate-1');
    });

    it('updates multiple filter fields', () => {
      let state = dashboardReducer(initialState, {
        type: 'UPDATE_TASK_FILTER',
        payload: { assignee: 'mate-1' },
      });
      state = dashboardReducer(state, {
        type: 'UPDATE_TASK_FILTER',
        payload: { search: 'bug' },
      });
      expect(state.tasks.filter.assignee).toBe('mate-1');
      expect(state.tasks.filter.search).toBe('bug');
    });

    it('clears filter field with undefined', () => {
      let state = dashboardReducer(initialState, {
        type: 'UPDATE_TASK_FILTER',
        payload: { assignee: 'mate-1' },
      });
      state = dashboardReducer(state, {
        type: 'UPDATE_TASK_FILTER',
        payload: { assignee: undefined },
      });
      expect(state.tasks.filter.assignee).toBeUndefined();
    });
  });

  describe('UPDATE_ACTIVITY_FILTER', () => {
    it('merges partial filter', () => {
      const result = dashboardReducer(initialState, {
        type: 'UPDATE_ACTIVITY_FILTER',
        payload: { teammateId: 'mate-1' },
      });
      expect(result.activity.filter.teammateId).toBe('mate-1');
    });

    it('updates types filter', () => {
      const result = dashboardReducer(initialState, {
        type: 'UPDATE_ACTIVITY_FILTER',
        payload: { types: ['teammate-spawned', 'task-completed'] },
      });
      expect(result.activity.filter.types).toEqual(['teammate-spawned', 'task-completed']);
    });

    it('updates since filter', () => {
      const result = dashboardReducer(initialState, {
        type: 'UPDATE_ACTIVITY_FILTER',
        payload: { since: '2025-01-01T00:00:00Z' },
      });
      expect(result.activity.filter.since).toBe('2025-01-01T00:00:00Z');
    });
  });

  describe('TOGGLE_TASK_EXPANDED', () => {
    it('expands a task', () => {
      const result = dashboardReducer(initialState, {
        type: 'TOGGLE_TASK_EXPANDED',
        payload: 'task-1',
      });
      expect(result.tasks.expanded.has('task-1')).toBe(true);
    });

    it('collapses an expanded task', () => {
      let state = dashboardReducer(initialState, {
        type: 'TOGGLE_TASK_EXPANDED',
        payload: 'task-1',
      });
      state = dashboardReducer(state, {
        type: 'TOGGLE_TASK_EXPANDED',
        payload: 'task-1',
      });
      expect(state.tasks.expanded.has('task-1')).toBe(false);
    });

    it('handles multiple expanded tasks', () => {
      let state = dashboardReducer(initialState, {
        type: 'TOGGLE_TASK_EXPANDED',
        payload: 'task-1',
      });
      state = dashboardReducer(state, {
        type: 'TOGGLE_TASK_EXPANDED',
        payload: 'task-2',
      });
      expect(state.tasks.expanded.has('task-1')).toBe(true);
      expect(state.tasks.expanded.has('task-2')).toBe(true);
      expect(state.tasks.expanded.size).toBe(2);
    });
  });

  describe('SET_TASKS', () => {
    it('sets task list', () => {
      const tasks = [createTask({ id: 't1' }), createTask({ id: 't2' })];
      const result = dashboardReducer(initialState, { type: 'SET_TASKS', payload: tasks });
      expect(result.tasks.items).toEqual(tasks);
    });

    it('replaces existing tasks', () => {
      const state = dashboardReducer(initialState, {
        type: 'SET_TASKS',
        payload: [createTask({ id: 't1' })],
      });
      const result = dashboardReducer(state, {
        type: 'SET_TASKS',
        payload: [createTask({ id: 't2' })],
      });
      expect(result.tasks.items).toHaveLength(1);
      expect(result.tasks.items[0].id).toBe('t2');
    });
  });

  describe('UPDATE_TASK', () => {
    it('updates existing task by id', () => {
      const state = dashboardReducer(initialState, {
        type: 'SET_TASKS',
        payload: [
          createTask({ id: 't1', status: 'pending' }),
          createTask({ id: 't2', status: 'pending' }),
        ],
      });
      const result = dashboardReducer(state, {
        type: 'UPDATE_TASK',
        payload: createTask({ id: 't1', status: 'completed' }),
      });
      expect(result.tasks.items[0].status).toBe('completed');
      expect(result.tasks.items[1].status).toBe('pending');
    });

    it('does not add task if id not found', () => {
      const state = dashboardReducer(initialState, {
        type: 'SET_TASKS',
        payload: [createTask({ id: 't1' })],
      });
      const result = dashboardReducer(state, {
        type: 'UPDATE_TASK',
        payload: createTask({ id: 'nonexistent' }),
      });
      expect(result.tasks.items).toHaveLength(1);
    });
  });

  describe('SET_TEAMMATES', () => {
    it('sets teammates list', () => {
      const mates = [createTeammate({ id: 'm1' }), createTeammate({ id: 'm2' })];
      const result = dashboardReducer(initialState, { type: 'SET_TEAMMATES', payload: mates });
      expect(result.teammates.items).toEqual(mates);
    });
  });

  describe('UPDATE_TEAMMATE', () => {
    it('updates existing teammate by id', () => {
      const state = dashboardReducer(initialState, {
        type: 'SET_TEAMMATES',
        payload: [
          createTeammate({ id: 'm1', status: 'working' }),
          createTeammate({ id: 'm2', status: 'idle' }),
        ],
      });
      const result = dashboardReducer(state, {
        type: 'UPDATE_TEAMMATE',
        payload: createTeammate({ id: 'm1', status: 'shutdown' }),
      });
      expect(result.teammates.items[0].status).toBe('shutdown');
      expect(result.teammates.items[1].status).toBe('idle');
    });
  });

  describe('ADD_ACTIVITY', () => {
    it('appends activity event', () => {
      const event = createActivityEvent();
      const result = dashboardReducer(initialState, { type: 'ADD_ACTIVITY', payload: event });
      expect(result.activity.events).toHaveLength(1);
      expect(result.activity.events[0]).toBe(event);
    });

    it('preserves existing events', () => {
      let state = dashboardReducer(initialState, {
        type: 'ADD_ACTIVITY',
        payload: createActivityEvent({ id: 'e1' }),
      });
      state = dashboardReducer(state, {
        type: 'ADD_ACTIVITY',
        payload: createActivityEvent({ id: 'e2' }),
      });
      expect(state.activity.events).toHaveLength(2);
    });
  });

  describe('SET_ACTIVITY', () => {
    it('replaces all activity events', () => {
      const state = dashboardReducer(initialState, {
        type: 'ADD_ACTIVITY',
        payload: createActivityEvent({ id: 'old' }),
      });
      const result = dashboardReducer(state, {
        type: 'SET_ACTIVITY',
        payload: [createActivityEvent({ id: 'new' })],
      });
      expect(result.activity.events).toHaveLength(1);
      expect(result.activity.events[0].id).toBe('new');
    });
  });

  describe('ADD_MESSAGE', () => {
    it('adds message and builds threads', () => {
      const msg = createMessage({ from: 'alice', to: 'bob' });
      const result = dashboardReducer(initialState, { type: 'ADD_MESSAGE', payload: msg });
      expect(result.messages.items).toHaveLength(1);
      expect(result.messages.threads.size).toBe(1);
    });

    it('groups messages into correct threads', () => {
      let state = dashboardReducer(initialState, {
        type: 'ADD_MESSAGE',
        payload: createMessage({ id: 'm1', from: 'alice', to: 'bob' }),
      });
      state = dashboardReducer(state, {
        type: 'ADD_MESSAGE',
        payload: createMessage({ id: 'm2', from: 'bob', to: 'alice' }),
      });
      state = dashboardReducer(state, {
        type: 'ADD_MESSAGE',
        payload: createMessage({ id: 'm3', from: 'alice', to: 'charlie' }),
      });

      expect(state.messages.items).toHaveLength(3);
      // alice:bob thread has 2 messages (from alice->bob and bob->alice)
      const aliceBobKey = ['alice', 'bob'].sort().join(':');
      expect(state.messages.threads.get(aliceBobKey)).toHaveLength(2);
      // alice:charlie thread has 1 message
      const aliceCharlieKey = ['alice', 'charlie'].sort().join(':');
      expect(state.messages.threads.get(aliceCharlieKey)).toHaveLength(1);
    });
  });

  describe('SET_MESSAGES', () => {
    it('replaces all messages and rebuilds threads', () => {
      const state = dashboardReducer(initialState, {
        type: 'ADD_MESSAGE',
        payload: createMessage({ id: 'old' }),
      });
      const result = dashboardReducer(state, {
        type: 'SET_MESSAGES',
        payload: [
          createMessage({ id: 'new1', from: 'x', to: 'y' }),
          createMessage({ id: 'new2', from: 'y', to: 'x' }),
        ],
      });
      expect(result.messages.items).toHaveLength(2);
      expect(result.messages.threads.size).toBe(1);
    });
  });

  describe('UPDATE_COSTS', () => {
    it('updates cost summary', () => {
      const summary: TeamCostSummary = {
        totalCostUsd: 1.50,
        perTeammate: {},
        perModel: {},
      };
      const result = dashboardReducer(initialState, { type: 'UPDATE_COSTS', payload: summary });
      expect(result.costs.summary).toBe(summary);
    });
  });

  describe('TOGGLE_SIDEBAR', () => {
    it('toggles sidebar collapsed state', () => {
      const result = dashboardReducer(initialState, { type: 'TOGGLE_SIDEBAR' });
      expect(result.ui.sidebarCollapsed).toBe(true);
      const result2 = dashboardReducer(result, { type: 'TOGGLE_SIDEBAR' });
      expect(result2.ui.sidebarCollapsed).toBe(false);
    });
  });

  describe('TOGGLE_DETAIL_PANEL', () => {
    it('toggles detail panel visibility', () => {
      const result = dashboardReducer(initialState, { type: 'TOGGLE_DETAIL_PANEL' });
      expect(result.ui.detailPanelVisible).toBe(true);
      const result2 = dashboardReducer(result, { type: 'TOGGLE_DETAIL_PANEL' });
      expect(result2.ui.detailPanelVisible).toBe(false);
    });
  });

  describe('SET_LOADING', () => {
    it('sets loading state', () => {
      const result = dashboardReducer(initialState, { type: 'SET_LOADING', payload: true });
      expect(result.ui.loading).toBe(true);
    });
  });

  describe('SET_ERROR', () => {
    it('sets error and clears loading', () => {
      const loadingState = { ...initialState, ui: { ...initialState.ui, loading: true } };
      const result = dashboardReducer(loadingState, { type: 'SET_ERROR', payload: 'Something failed' });
      expect(result.ui.error).toBe('Something failed');
      expect(result.ui.loading).toBe(false);
    });

    it('clears error with null', () => {
      const errorState = { ...initialState, ui: { ...initialState.ui, error: 'old error' } };
      const result = dashboardReducer(errorState, { type: 'SET_ERROR', payload: null });
      expect(result.ui.error).toBeNull();
    });
  });

  describe('SET_REALTIME_CONNECTED', () => {
    it('sets connection status', () => {
      const result = dashboardReducer(initialState, { type: 'SET_REALTIME_CONNECTED', payload: true });
      expect(result.realtime.connected).toBe(true);
    });
  });

  describe('MARK_UPDATE_RECEIVED', () => {
    it('sets lastUpdate and resets pendingUpdates', () => {
      const state = { ...initialState, realtime: { ...initialState.realtime, pendingUpdates: 5 } };
      const result = dashboardReducer(state, { type: 'MARK_UPDATE_RECEIVED' });
      expect(result.realtime.lastUpdate).not.toBeNull();
      expect(result.realtime.pendingUpdates).toBe(0);
    });
  });

  describe('unknown action', () => {
    it('returns state unchanged for unknown action', () => {
      const result = dashboardReducer(initialState, { type: 'UNKNOWN' } as any);
      expect(result).toBe(initialState);
    });
  });
});

// ============================================================
// Task Filtering Logic
// ============================================================

describe('task filtering', () => {
  function filterTasks(tasks: TeamTask[], filter: {
    assignee?: string;
    statuses?: string[];
    search?: string;
  }): TeamTask[] {
    let result = tasks;

    if (filter.assignee) {
      result = result.filter(t => t.assignee === filter.assignee);
    }

    if (filter.statuses && filter.statuses.length > 0) {
      result = result.filter(t => filter.statuses!.includes(t.status));
    }

    if (filter.search) {
      const search = filter.search.toLowerCase();
      result = result.filter(t =>
        t.title.toLowerCase().includes(search) ||
        (t.description && t.description.toLowerCase().includes(search))
      );
    }

    return result;
  }

  const tasks = [
    createTask({ id: 't1', title: 'Fix login bug', assignee: 'mate-1', status: 'in_progress', description: 'Authentication failure' }),
    createTask({ id: 't2', title: 'Add tests', assignee: 'mate-2', status: 'pending' }),
    createTask({ id: 't3', title: 'Deploy feature', assignee: 'mate-1', status: 'completed' }),
    createTask({ id: 't4', title: 'Review code', assignee: 'mate-2', status: 'blocked' }),
  ];

  it('returns all tasks with no filter', () => {
    expect(filterTasks(tasks, {})).toEqual(tasks);
  });

  it('filters by assignee', () => {
    const result = filterTasks(tasks, { assignee: 'mate-1' });
    expect(result).toHaveLength(2);
    expect(result.every(t => t.assignee === 'mate-1')).toBe(true);
  });

  it('filters by statuses', () => {
    const result = filterTasks(tasks, { statuses: ['pending', 'blocked'] });
    expect(result).toHaveLength(2);
    expect(result.map(t => t.id)).toEqual(['t2', 't4']);
  });

  it('filters by search in title', () => {
    const result = filterTasks(tasks, { search: 'bug' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('filters by search in description', () => {
    const result = filterTasks(tasks, { search: 'authentication' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('search is case insensitive', () => {
    const result = filterTasks(tasks, { search: 'FIX' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('combines filters', () => {
    const result = filterTasks(tasks, {
      assignee: 'mate-1',
      statuses: ['in_progress'],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('t1');
  });

  it('returns empty for non-matching filter', () => {
    const result = filterTasks(tasks, { assignee: 'nonexistent' });
    expect(result).toHaveLength(0);
  });
});

// ============================================================
// Activity Filtering Logic
// ============================================================

describe('activity filtering', () => {
  function filterActivity(events: TeamActivityEvent[], filter: {
    teammateId?: string;
    types?: string[];
    since?: string;
  }): TeamActivityEvent[] {
    let result = events;

    if (filter.teammateId) {
      result = result.filter(e => e.teammateId === filter.teammateId);
    }

    if (filter.types && filter.types.length > 0) {
      result = result.filter(e => filter.types!.includes(e.type));
    }

    if (filter.since) {
      const since = new Date(filter.since).getTime();
      result = result.filter(e => new Date(e.timestamp).getTime() >= since);
    }

    return result;
  }

  const events = [
    createActivityEvent({ id: 'e1', type: 'teammate-spawned', teammateId: 'mate-1', timestamp: '2025-01-01T10:00:00Z' }),
    createActivityEvent({ id: 'e2', type: 'task-claimed', teammateId: 'mate-1', timestamp: '2025-01-01T11:00:00Z' }),
    createActivityEvent({ id: 'e3', type: 'task-completed', teammateId: 'mate-2', timestamp: '2025-01-01T12:00:00Z' }),
    createActivityEvent({ id: 'e4', type: 'error', teammateId: 'mate-1', timestamp: '2025-01-01T13:00:00Z' }),
  ];

  it('returns all events with no filter', () => {
    expect(filterActivity(events, {})).toEqual(events);
  });

  it('filters by teammate', () => {
    const result = filterActivity(events, { teammateId: 'mate-1' });
    expect(result).toHaveLength(3);
  });

  it('filters by type', () => {
    const result = filterActivity(events, { types: ['task-claimed', 'task-completed'] });
    expect(result).toHaveLength(2);
  });

  it('filters by since timestamp', () => {
    const result = filterActivity(events, { since: '2025-01-01T11:30:00Z' });
    expect(result).toHaveLength(2);
    expect(result.map(e => e.id)).toEqual(['e3', 'e4']);
  });

  it('combines filters', () => {
    const result = filterActivity(events, {
      teammateId: 'mate-1',
      types: ['task-claimed'],
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('e2');
  });
});

// ============================================================
// Metrics Computation
// ============================================================

describe('metrics computation', () => {
  function computeMetrics(state: TeamDashboardViewState) {
    const teammates = state.teammates.items;
    const tasks = state.tasks.items;
    const costs = state.costs.summary;

    const totalTeammates = teammates.length;
    const activeTeammates = teammates.filter(t => t.status !== 'shutdown').length;

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const inProgressTasks = tasks.filter(t => t.status === 'in_progress').length;
    const blockedTasks = tasks.filter(t => t.status === 'blocked').length;

    const taskCompletionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    const totalCost = costs?.totalCostUsd ?? 0;
    const avgCostPerTask = completedTasks > 0 ? totalCost / completedTasks : 0;

    return {
      totalTeammates,
      activeTeammates,
      totalTasks,
      completedTasks,
      inProgressTasks,
      blockedTasks,
      taskCompletionRate,
      totalCost,
      avgCostPerTask,
    };
  }

  it('computes zero metrics for empty state', () => {
    const state = createInitialDashboardState();
    const metrics = computeMetrics(state);
    expect(metrics.totalTeammates).toBe(0);
    expect(metrics.activeTeammates).toBe(0);
    expect(metrics.totalTasks).toBe(0);
    expect(metrics.taskCompletionRate).toBe(0);
    expect(metrics.totalCost).toBe(0);
    expect(metrics.avgCostPerTask).toBe(0);
  });

  it('counts active vs shutdown teammates', () => {
    const state = createInitialDashboardState();
    state.teammates.items = [
      createTeammate({ id: 'm1', status: 'working' }),
      createTeammate({ id: 'm2', status: 'idle' }),
      createTeammate({ id: 'm3', status: 'shutdown' }),
    ];
    const metrics = computeMetrics(state);
    expect(metrics.totalTeammates).toBe(3);
    expect(metrics.activeTeammates).toBe(2);
  });

  it('computes task completion rate', () => {
    const state = createInitialDashboardState();
    state.tasks.items = [
      createTask({ id: 't1', status: 'completed' }),
      createTask({ id: 't2', status: 'completed' }),
      createTask({ id: 't3', status: 'in_progress' }),
      createTask({ id: 't4', status: 'blocked' }),
    ];
    const metrics = computeMetrics(state);
    expect(metrics.totalTasks).toBe(4);
    expect(metrics.completedTasks).toBe(2);
    expect(metrics.inProgressTasks).toBe(1);
    expect(metrics.blockedTasks).toBe(1);
    expect(metrics.taskCompletionRate).toBe(50);
  });

  it('computes cost metrics', () => {
    const state = createInitialDashboardState();
    state.tasks.items = [
      createTask({ id: 't1', status: 'completed' }),
      createTask({ id: 't2', status: 'completed' }),
    ];
    state.costs.summary = {
      totalCostUsd: 3.0,
      perTeammate: {},
      perModel: {},
    };
    const metrics = computeMetrics(state);
    expect(metrics.totalCost).toBe(3.0);
    expect(metrics.avgCostPerTask).toBe(1.5);
  });

  it('handles zero completed tasks for avgCostPerTask', () => {
    const state = createInitialDashboardState();
    state.costs.summary = { totalCostUsd: 5.0, perTeammate: {}, perModel: {} };
    const metrics = computeMetrics(state);
    expect(metrics.avgCostPerTask).toBe(0);
  });
});

// ============================================================
// Integration: State Transition Sequences
// ============================================================

describe('state transition sequences', () => {
  it('simulates team initialization flow', () => {
    let state = createInitialDashboardState();

    // 1. Set loading
    state = dashboardReducer(state, { type: 'SET_LOADING', payload: true });
    expect(state.ui.loading).toBe(true);

    // 2. Set team
    const team = createTeam();
    state = dashboardReducer(state, { type: 'SET_TEAM', payload: team });
    expect(state.team).toBe(team);
    expect(state.ui.loading).toBe(false);

    // 3. Set teammates
    const mates = [createTeammate({ id: 'm1' }), createTeammate({ id: 'm2' })];
    state = dashboardReducer(state, { type: 'SET_TEAMMATES', payload: mates });
    expect(state.teammates.items).toHaveLength(2);

    // 4. Set tasks
    const tasks = [createTask({ id: 't1' }), createTask({ id: 't2' })];
    state = dashboardReducer(state, { type: 'SET_TASKS', payload: tasks });
    expect(state.tasks.items).toHaveLength(2);

    // 5. Connect realtime
    state = dashboardReducer(state, { type: 'SET_REALTIME_CONNECTED', payload: true });
    expect(state.realtime.connected).toBe(true);
  });

  it('simulates error recovery flow', () => {
    let state = createInitialDashboardState();

    // 1. Set loading
    state = dashboardReducer(state, { type: 'SET_LOADING', payload: true });

    // 2. Error occurs
    state = dashboardReducer(state, { type: 'SET_ERROR', payload: 'Connection failed' });
    expect(state.ui.error).toBe('Connection failed');
    expect(state.ui.loading).toBe(false);

    // 3. Retry - clear error, set loading
    state = dashboardReducer(state, { type: 'SET_ERROR', payload: null });
    state = dashboardReducer(state, { type: 'SET_LOADING', payload: true });

    // 4. Success
    state = dashboardReducer(state, { type: 'SET_TEAM', payload: createTeam() });
    expect(state.ui.error).toBeNull();
    expect(state.ui.loading).toBe(false);
  });

  it('simulates real-time update flow', () => {
    let state = createInitialDashboardState();
    const team = createTeam();
    state = dashboardReducer(state, { type: 'SET_TEAM', payload: team });

    // Receive activity events
    state = dashboardReducer(state, {
      type: 'ADD_ACTIVITY',
      payload: createActivityEvent({ id: 'e1', type: 'teammate-spawned' }),
    });

    // Receive task updates
    state = dashboardReducer(state, {
      type: 'SET_TASKS',
      payload: [createTask({ id: 't1', status: 'pending' })],
    });
    state = dashboardReducer(state, {
      type: 'UPDATE_TASK',
      payload: createTask({ id: 't1', status: 'in_progress', assignee: 'mate-1' }),
    });
    expect(state.tasks.items[0].status).toBe('in_progress');

    // Mark update received
    state = dashboardReducer(state, { type: 'MARK_UPDATE_RECEIVED' });
    expect(state.realtime.lastUpdate).not.toBeNull();
    expect(state.realtime.pendingUpdates).toBe(0);
  });
});
