/**
 * useTeamDashboard Hook
 *
 * React hook for managing team dashboard view state.
 * Provides state management, actions, and derived metrics.
 *
 * Phase 1: State adapter for dashboard components
 */

import { useReducer, useCallback, useMemo } from 'react';
import type {
  TeamDashboardViewState,
  DashboardViewAction,
  DashboardPanel,
  TaskFilter,
  ActivityFilter,
  DashboardMetrics,
  AgentTeam,
  AgentTeammate,
  TeamTask,
  TeammateMessage,
  TeamActivityEvent,
  TeamCostSummary,
} from '@craft-agent/core/types';
import { createInitialDashboardState } from '@craft-agent/core/types';

// ============================================================
// State Reducer
// ============================================================

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
      // Rebuild threads
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
      // Rebuild threads
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
// Hook Interface
// ============================================================

export interface UseTeamDashboardResult {
  // State
  state: TeamDashboardViewState;

  // Derived metrics
  metrics: DashboardMetrics;

  // Actions
  actions: {
    setTeam: (team: AgentTeam) => void;
    setActivePanel: (panel: DashboardPanel) => void;
    selectTeammate: (teammate: AgentTeammate | null) => void;
    updateTaskFilter: (filter: Partial<TaskFilter>) => void;
    updateActivityFilter: (filter: Partial<ActivityFilter>) => void;
    toggleTaskExpanded: (taskId: string) => void;
    setTasks: (tasks: TeamTask[]) => void;
    updateTask: (task: TeamTask) => void;
    setTeammates: (teammates: AgentTeammate[]) => void;
    updateTeammate: (teammate: AgentTeammate) => void;
    addActivity: (event: TeamActivityEvent) => void;
    setActivity: (events: TeamActivityEvent[]) => void;
    addMessage: (message: TeammateMessage) => void;
    setMessages: (messages: TeammateMessage[]) => void;
    updateCosts: (summary: TeamCostSummary) => void;
    toggleSidebar: () => void;
    toggleDetailPanel: () => void;
    setLoading: (loading: boolean) => void;
    setError: (error: string | null) => void;
    setRealtimeConnected: (connected: boolean) => void;
    markUpdateReceived: () => void;
  };

  // Filtered data
  filteredTasks: TeamTask[];
  filteredActivity: TeamActivityEvent[];
}

// ============================================================
// Hook Implementation
// ============================================================

/**
 * Hook for managing team dashboard state
 *
 * @example
 * ```tsx
 * const { state, actions, metrics, filteredTasks } = useTeamDashboard();
 *
 * // Set team
 * actions.setTeam(team);
 *
 * // Navigate panels
 * actions.setActivePanel('tasks');
 *
 * // Select teammate
 * actions.selectTeammate(teammate);
 *
 * // Display metrics
 * <div>Progress: {metrics.taskCompletionRate}%</div>
 * ```
 */
export function useTeamDashboard(): UseTeamDashboardResult {
  const [state, dispatch] = useReducer(dashboardReducer, createInitialDashboardState());

  // ============================================================
  // Actions
  // ============================================================

  const actions = useMemo(() => ({
    setTeam: (team: AgentTeam) => dispatch({ type: 'SET_TEAM', payload: team }),
    setActivePanel: (panel: DashboardPanel) => dispatch({ type: 'SET_ACTIVE_PANEL', payload: panel }),
    selectTeammate: (teammate: AgentTeammate | null) => dispatch({ type: 'SELECT_TEAMMATE', payload: teammate }),
    updateTaskFilter: (filter: Partial<TaskFilter>) => dispatch({ type: 'UPDATE_TASK_FILTER', payload: filter }),
    updateActivityFilter: (filter: Partial<ActivityFilter>) => dispatch({ type: 'UPDATE_ACTIVITY_FILTER', payload: filter }),
    toggleTaskExpanded: (taskId: string) => dispatch({ type: 'TOGGLE_TASK_EXPANDED', payload: taskId }),
    setTasks: (tasks: TeamTask[]) => dispatch({ type: 'SET_TASKS', payload: tasks }),
    updateTask: (task: TeamTask) => dispatch({ type: 'UPDATE_TASK', payload: task }),
    setTeammates: (teammates: AgentTeammate[]) => dispatch({ type: 'SET_TEAMMATES', payload: teammates }),
    updateTeammate: (teammate: AgentTeammate) => dispatch({ type: 'UPDATE_TEAMMATE', payload: teammate }),
    addActivity: (event: TeamActivityEvent) => dispatch({ type: 'ADD_ACTIVITY', payload: event }),
    setActivity: (events: TeamActivityEvent[]) => dispatch({ type: 'SET_ACTIVITY', payload: events }),
    addMessage: (message: TeammateMessage) => dispatch({ type: 'ADD_MESSAGE', payload: message }),
    setMessages: (messages: TeammateMessage[]) => dispatch({ type: 'SET_MESSAGES', payload: messages }),
    updateCosts: (summary: TeamCostSummary) => dispatch({ type: 'UPDATE_COSTS', payload: summary }),
    toggleSidebar: () => dispatch({ type: 'TOGGLE_SIDEBAR' }),
    toggleDetailPanel: () => dispatch({ type: 'TOGGLE_DETAIL_PANEL' }),
    setLoading: (loading: boolean) => dispatch({ type: 'SET_LOADING', payload: loading }),
    setError: (error: string | null) => dispatch({ type: 'SET_ERROR', payload: error }),
    setRealtimeConnected: (connected: boolean) => dispatch({ type: 'SET_REALTIME_CONNECTED', payload: connected }),
    markUpdateReceived: () => dispatch({ type: 'MARK_UPDATE_RECEIVED' }),
  }), []);

  // ============================================================
  // Filtered Data
  // ============================================================

  const filteredTasks = useMemo(() => {
    let tasks = state.tasks.items;

    // Filter by assignee
    if (state.tasks.filter.assignee) {
      tasks = tasks.filter(t => t.assignee === state.tasks.filter.assignee);
    }

    // Filter by status
    if (state.tasks.filter.statuses && state.tasks.filter.statuses.length > 0) {
      tasks = tasks.filter(t => state.tasks.filter.statuses!.includes(t.status));
    }

    // Filter by search
    if (state.tasks.filter.search) {
      const search = state.tasks.filter.search.toLowerCase();
      tasks = tasks.filter(t =>
        t.title.toLowerCase().includes(search) ||
        (t.description && t.description.toLowerCase().includes(search))
      );
    }

    return tasks;
  }, [state.tasks.items, state.tasks.filter]);

  const filteredActivity = useMemo(() => {
    let events = state.activity.events;

    // Filter by teammate
    if (state.activity.filter.teammateId) {
      events = events.filter(e => e.teammateId === state.activity.filter.teammateId);
    }

    // Filter by type
    if (state.activity.filter.types && state.activity.filter.types.length > 0) {
      events = events.filter(e => state.activity.filter.types!.includes(e.type));
    }

    // Filter by time range
    if (state.activity.filter.since) {
      const since = new Date(state.activity.filter.since).getTime();
      events = events.filter(e => new Date(e.timestamp).getTime() >= since);
    }

    return events;
  }, [state.activity.events, state.activity.filter]);

  // ============================================================
  // Derived Metrics
  // ============================================================

  const metrics = useMemo((): DashboardMetrics => {
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

    // Estimate time to completion based on recent task velocity
    let estimatedTimeToCompletion: number | null = null;
    if (completedTasks > 0 && inProgressTasks > 0) {
      const now = Date.now();
      const completedTasksWithDuration = tasks.filter(t =>
        t.status === 'completed' && t.completedAt && t.createdAt
      );
      if (completedTasksWithDuration.length > 0) {
        const avgDuration = completedTasksWithDuration.reduce((sum, t) => {
          const duration = new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime();
          return sum + duration;
        }, 0) / completedTasksWithDuration.length;
        estimatedTimeToCompletion = Math.round((avgDuration * inProgressTasks) / 60000); // minutes
      }
    }

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
      estimatedTimeToCompletion,
    };
  }, [state.teammates.items, state.tasks.items, state.costs.summary]);

  // ============================================================
  // Return
  // ============================================================

  return {
    state,
    metrics,
    actions,
    filteredTasks,
    filteredActivity,
  };
}
