/**
 * Team Dashboard View State Types
 *
 * Typed state for the team dashboard UI - tracks the current view,
 * selected teammate, filters, and real-time team activity.
 *
 * Phase 1: Foundations for dashboard state management
 */

import type {
  AgentTeam,
  AgentTeammate,
  TeamTask,
  TeammateMessage,
  TeamActivityEvent,
  TeamCostSummary,
  TeamTaskStatus,
  TeamActivityType,
} from './agent-teams.ts';

// ============================================================
// Dashboard View Configuration
// ============================================================

/**
 * Which panel is currently active in the dashboard
 */
export type DashboardPanel = 'overview' | 'tasks' | 'teammates' | 'activity' | 'costs';

/**
 * Task list filter options
 */
export interface TaskFilter {
  /** Show only tasks assigned to a specific teammate */
  assignee?: string;
  /** Show only tasks with these statuses */
  statuses?: TeamTaskStatus[];
  /** Search query for task title/description */
  search?: string;
}

/**
 * Activity feed filter options
 */
export interface ActivityFilter {
  /** Show only activities from a specific teammate */
  teammateId?: string;
  /** Show only specific activity types */
  types?: TeamActivityType[];
  /** Time range for activities (ISO timestamps) */
  since?: string;
}

// ============================================================
// Dashboard View State
// ============================================================

/**
 * Complete state for the team dashboard view
 */
export interface TeamDashboardViewState {
  /** The team being displayed */
  team: AgentTeam | null;

  /** Current active panel */
  activePanel: DashboardPanel;

  /** Currently selected teammate (for detail view) */
  selectedTeammate: AgentTeammate | null;

  /** Task list state */
  tasks: {
    /** All tasks for this team */
    items: TeamTask[];
    /** Active filter */
    filter: TaskFilter;
    /** Expanded task IDs (for detail view) */
    expanded: Set<string>;
  };

  /** Teammates state */
  teammates: {
    /** All teammates for this team */
    items: AgentTeammate[];
    /** Sort order */
    sortBy: 'name' | 'status' | 'model' | 'cost';
  };

  /** Activity feed state */
  activity: {
    /** Activity events */
    events: TeamActivityEvent[];
    /** Active filter */
    filter: ActivityFilter;
    /** Whether auto-scroll is enabled */
    autoScroll: boolean;
  };

  /** Messages state */
  messages: {
    /** All inter-teammate messages */
    items: TeammateMessage[];
    /** Messages grouped by conversation thread */
    threads: Map<string, TeammateMessage[]>;
  };

  /** Cost tracking state */
  costs: {
    /** Cost summary */
    summary: TeamCostSummary | null;
    /** Whether cost details are expanded */
    expanded: boolean;
  };

  /** UI state */
  ui: {
    /** Whether sidebar is collapsed */
    sidebarCollapsed: boolean;
    /** Whether detail panel is visible */
    detailPanelVisible: boolean;
    /** Loading state */
    loading: boolean;
    /** Error state */
    error: string | null;
  };

  /** Real-time update state */
  realtime: {
    /** Whether real-time updates are connected */
    connected: boolean;
    /** Last update timestamp */
    lastUpdate: string | null;
    /** Pending updates count (for batching) */
    pendingUpdates: number;
  };
}

// ============================================================
// View State Actions
// ============================================================

/**
 * Actions that can be performed on the dashboard view state
 */
export type DashboardViewAction =
  | { type: 'SET_TEAM'; payload: AgentTeam }
  | { type: 'SET_ACTIVE_PANEL'; payload: DashboardPanel }
  | { type: 'SELECT_TEAMMATE'; payload: AgentTeammate | null }
  | { type: 'UPDATE_TASK_FILTER'; payload: Partial<TaskFilter> }
  | { type: 'UPDATE_ACTIVITY_FILTER'; payload: Partial<ActivityFilter> }
  | { type: 'TOGGLE_TASK_EXPANDED'; payload: string }
  | { type: 'SET_TASKS'; payload: TeamTask[] }
  | { type: 'UPDATE_TASK'; payload: TeamTask }
  | { type: 'SET_TEAMMATES'; payload: AgentTeammate[] }
  | { type: 'UPDATE_TEAMMATE'; payload: AgentTeammate }
  | { type: 'ADD_ACTIVITY'; payload: TeamActivityEvent }
  | { type: 'SET_ACTIVITY'; payload: TeamActivityEvent[] }
  | { type: 'ADD_MESSAGE'; payload: TeammateMessage }
  | { type: 'SET_MESSAGES'; payload: TeammateMessage[] }
  | { type: 'UPDATE_COSTS'; payload: TeamCostSummary }
  | { type: 'TOGGLE_SIDEBAR' }
  | { type: 'TOGGLE_DETAIL_PANEL' }
  | { type: 'SET_LOADING'; payload: boolean }
  | { type: 'SET_ERROR'; payload: string | null }
  | { type: 'SET_REALTIME_CONNECTED'; payload: boolean }
  | { type: 'MARK_UPDATE_RECEIVED' };

// ============================================================
// Teammate Detail View State
// ============================================================

/**
 * State for the teammate detail panel
 */
export interface TeammateDetailViewState {
  /** The teammate being displayed */
  teammate: AgentTeammate;

  /** Tasks assigned to this teammate */
  tasks: TeamTask[];

  /** Messages sent/received by this teammate */
  messages: TeammateMessage[];

  /** Activity events for this teammate */
  activity: TeamActivityEvent[];

  /** Whether to show message composer */
  showMessageComposer: boolean;

  /** Draft message content */
  draftMessage: string;
}

// ============================================================
// Dashboard Metrics (Derived State)
// ============================================================

/**
 * Computed metrics for the dashboard overview panel
 */
export interface DashboardMetrics {
  /** Total teammates */
  totalTeammates: number;

  /** Active teammates (not shutdown) */
  activeTeammates: number;

  /** Total tasks */
  totalTasks: number;

  /** Completed tasks */
  completedTasks: number;

  /** In-progress tasks */
  inProgressTasks: number;

  /** Blocked tasks */
  blockedTasks: number;

  /** Task completion percentage */
  taskCompletionRate: number;

  /** Total cost (USD) */
  totalCost: number;

  /** Average cost per task */
  avgCostPerTask: number;

  /** Estimated time to completion (minutes, based on current velocity) */
  estimatedTimeToCompletion: number | null;
}

// ============================================================
// Initial State Factory
// ============================================================

/**
 * Create initial dashboard view state
 */
export function createInitialDashboardState(): TeamDashboardViewState {
  return {
    team: null,
    activePanel: 'overview',
    selectedTeammate: null,
    tasks: {
      items: [],
      filter: {},
      expanded: new Set(),
    },
    teammates: {
      items: [],
      sortBy: 'status',
    },
    activity: {
      events: [],
      filter: {},
      autoScroll: true,
    },
    messages: {
      items: [],
      threads: new Map(),
    },
    costs: {
      summary: null,
      expanded: false,
    },
    ui: {
      sidebarCollapsed: false,
      detailPanelVisible: false,
      loading: false,
      error: null,
    },
    realtime: {
      connected: false,
      lastUpdate: null,
      pendingUpdates: 0,
    },
  };
}
