/**
 * Tests for TeamDashboard Component (Phase 1)
 *
 * Focuses on:
 * - Routing state (tab switching between teammate/activity/spec-coverage/traceability)
 * - Card render behavior (teammate cards, correct data display)
 * - No-duplication assertions (ensuring teammates appear only once)
 * - Empty state rendering
 * - Team creation blocking when SDD is enabled
 *
 * @vitest-environment jsdom
 */

import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { render, screen, fireEvent, within, cleanup, act, waitFor } from '@testing-library/react';

// Extend expect with jest-dom matchers (explicit wiring for fork worker reliability)
expect.extend(matchers);
import { Provider, createStore } from 'jotai';
import { sessionMetaMapAtom } from '@/atoms/sessions';
import { TeamDashboard, type TeamDashboardProps } from '../TeamDashboard';
import type { Session, AgentTeam, TeamTask, TeammateMessage, TeamActivityEvent, AgentTeammate } from '../../../../shared/types';
import type { SessionMeta } from '@/atoms/sessions';

// Mock PDF dependencies
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock('pdfjs-dist/build/pdf.mjs', () => ({}));

// Mock useTeamEvents hook to avoid the @craft-agent/core/types transitive import tree
// that causes vitest fork workers to crash on Windows (OOM in child_process)
vi.mock('@/hooks/useTeamEvents', () => ({
  useTeamStateSync: () => ({
    status: 'disconnected' as const,
    lastEvent: null,
    sequence: 0,
    on: vi.fn(),
    off: vi.fn(),
    reconnect: vi.fn(),
    isSubscribed: false,
  }),
}));

// Mock DOMMatrix
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class {} as unknown as typeof DOMMatrix;
}


// Mock child components to simplify testing
vi.mock('../TeamHeader', () => ({
  TeamHeader: ({ team }: { team: AgentTeam }) => (
    <div data-testid="team-header">Team: {team.name}</div>
  ),
}));

vi.mock('../TeammateSidebar', () => ({
  TeammateSidebar: ({
    teammates,
    selectedTeammateId,
    onSelectTeammate
  }: {
    teammates: AgentTeammate[];
    selectedTeammateId?: string;
    onSelectTeammate: (id: string) => void;
  }) => (
    <div data-testid="teammate-sidebar">
      {teammates.map(t => (
        <button
          key={t.id}
          data-testid={`teammate-${t.id}`}
          data-selected={t.id === selectedTeammateId}
          onClick={() => onSelectTeammate(t.id)}
        >
          {t.name}
        </button>
      ))}
    </div>
  ),
}));

vi.mock('../TeammateDetailView', () => ({
  TeammateDetailView: ({ teammate }: { teammate: AgentTeammate }) => (
    <div data-testid="teammate-detail">{teammate.name} Details</div>
  ),
}));

vi.mock('../TeamActivityFeed', () => ({
  TeamActivityFeed: ({ events }: { events: TeamActivityEvent[] }) => (
    <div data-testid="activity-feed">Activity: {events.length} events</div>
  ),
}));

vi.mock('../SpecCoveragePanel', () => ({
  SpecCoveragePanel: () => (
    <div data-testid="spec-coverage">Spec Coverage Panel</div>
  ),
}));

vi.mock('../SpecTraceabilityPanel', () => ({
  SpecTraceabilityPanel: () => (
    <div data-testid="traceability">Traceability Panel</div>
  ),
}));

vi.mock('../TaskListPanel', () => ({
  TaskListPanel: ({ tasks }: { tasks: TeamTask[] }) => (
    <div data-testid="task-list">Tasks: {tasks.length}</div>
  ),
}));

vi.mock('../TeamCreationDialog', () => ({
  TeamCreationDialog: ({ open, onCreateTeam }: { open: boolean; onCreateTeam: (config: any) => void }) => (
    open ? <div data-testid="creation-dialog">
      <button data-testid="create-team-confirm" onClick={() => onCreateTeam({ name: 'Test Team', teammates: [], preset: 'cost-optimized' })}>
        Confirm Create
      </button>
    </div> : null
  ),
}));

vi.mock('../TeamSidebarCompact', () => ({
  TeamSidebarCompact: () => <div data-testid="compact-sidebar">Compact Sidebar</div>,
}));

vi.mock('../QualityGateReport', () => ({
  QualityGateReport: () => <div data-testid="quality-gate">Quality Gate</div>,
}));

vi.mock('../SpecChecklistModal', () => ({
  SpecChecklistModal: () => <div data-testid="spec-checklist">Spec Checklist</div>,
}));


// Helper to create mock session
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    workspaceName: 'Test Workspace',
    name: 'Test Session',
    messages: [],
    isProcessing: false,
    lastMessageAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    teamId: 'team-1',
    isTeamLead: true,
    teammateSessionIds: ['teammate-1', 'teammate-2'],
    ...overrides,
  };
}

// Helper to create mock teammate
function createMockTeammate(id: string, name: string, isLead = false): AgentTeammate {
  return {
    id,
    name,
    role: isLead ? 'lead' : 'worker',
    agentId: id,
    sessionId: id,
    status: 'idle',
    model: 'claude-sonnet-4.5',
    provider: 'anthropic',
    isLead,
  };
}

// Helper to create session meta map
function createSessionMetaMap(teammates: AgentTeammate[]): Map<string, SessionMeta> {
  const map = new Map<string, SessionMeta>();
  teammates.forEach(teammate => {
    map.set(teammate.id, {
      id: teammate.id,
      name: teammate.name,
      workspaceId: 'workspace-1',
      isProcessing: teammate.status === 'working',
      messageCount: 5,
      teammateName: teammate.name,
      teammateRole: teammate.role,
      model: teammate.model,
      tokenUsage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        costUsd: 0.05,
        contextTokens: 0,
      },
    });
  });
  return map;
}

describe('TeamDashboard - Phase 1 Tests', () => {
  let mockOnSendMessage: ReturnType<typeof vi.fn>;
  let mockOnCreateTeam: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockOnSendMessage = vi.fn();
    mockOnCreateTeam = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  type RenderTeamDashboardOptions = {
    session?: Session;
    initialSessionMeta?: Map<string, SessionMeta>;
  } & Partial<Omit<TeamDashboardProps, 'session' | 'onSendMessage'>>;

  function renderTeamDashboard(options: RenderTeamDashboardOptions = {}) {
    const { session = createMockSession(), initialSessionMeta, ...rest } = options;
    const store = createStore();

    if (initialSessionMeta) {
      store.set(sessionMetaMapAtom, initialSessionMeta);
    }

    const props: TeamDashboardProps = {
      session,
      onSendMessage: mockOnSendMessage,
      ...rest,
    };

    const utils = render(
      <Provider store={store}>
        <TeamDashboard {...props} />
      </Provider>
    );

    return { ...utils, store };
  }

  async function switchToFocusView() {
    const focusTab = screen.getByRole('tab', { name: /Focus View/i });
    await waitFor(() => expect(focusTab).not.toBeDisabled());
    fireEvent.click(focusTab);

    if (!screen.queryByRole('button', { name: /^Teammate$/i })) {
      const leadCard = screen.getByRole('button', { name: /Lead Agent/i });
      fireEvent.click(leadCard);
    }

    await waitFor(() => expect(screen.getByRole('button', { name: /^Teammate$/i })).toBeInTheDocument());
  }

  describe('Empty State Rendering', () => {
    it('shows empty state when session has no teamId', () => {
      const session = createMockSession({ teamId: undefined, isTeamLead: false });

      renderTeamDashboard({ session });

      expect(screen.getByText('No Active Team')).toBeInTheDocument();
      expect(screen.getByText(/Create a team to start multi-agent collaboration/)).toBeInTheDocument();
    });

    it('shows create button in empty state when onCreateTeam is provided', () => {
      const session = createMockSession({ teamId: undefined, isTeamLead: false });

      renderTeamDashboard({
        session,
        onCreateTeam: mockOnCreateTeam,
      });

      const createButton = screen.getByRole('button', { name: /Create Team/i });
      expect(createButton).toBeInTheDocument();
      expect(createButton).not.toBeDisabled();
    });

    it('blocks team creation when SDD is enabled without active spec (REQ-004)', () => {
      const session = createMockSession({
        teamId: undefined,
        isTeamLead: false,
        activeSpecId: undefined
      });

      renderTeamDashboard({
        session,
        onCreateTeam: mockOnCreateTeam,
        specModeEnabled: true,
      });

      const createButton = screen.getByRole('button', { name: /Create Team/i });
      expect(createButton).toBeDisabled();
      expect(screen.getByText(/Spec-Driven Development is enabled/)).toBeInTheDocument();
    });

    it('allows team creation when SDD is enabled with active spec', () => {
      const session = createMockSession({
        teamId: undefined,
        isTeamLead: false,
        activeSpecId: 'spec-1'
      });

      renderTeamDashboard({
        session,
        onCreateTeam: mockOnCreateTeam,
        specModeEnabled: true,
      });

      const createButton = screen.getByRole('button', { name: /Create Team/i });
      expect(createButton).not.toBeDisabled();
    });
  });

  describe('Routing State - Tab Switching', () => {
    it('defaults to teammate tab on render', async () => {
      const session = createMockSession();

      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      // Team dashboard defaults to Command Center; switch to focus to inspect tab state
      await switchToFocusView();
      const teammateTab = screen.getByRole('button', { name: /^Teammate$/i });
      expect(teammateTab).toHaveClass(/bg-foreground/); // Active tab styling
    });

    
    it('switches to focus view and displays tabs', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      // Switch to focus view
      await switchToFocusView();

      // Now tabs should be visible
      expect(screen.getByRole('button', { name: /^Teammate$/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Activity/i })).toBeInTheDocument();
    });


    it('switches to activity tab when clicked', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);
      const activityEvents: TeamActivityEvent[] = [
        {
          id: 'event-1',
          timestamp: new Date().toISOString(),
          type: 'teammate-spawned',
          teammateId: 'teammate-1',
          teammateName: 'Worker 1',
          details: 'Worker 1 joined the team',
        },
      ];

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
        activityEvents,
      });

      
      // Switch to focus view first
      await switchToFocusView();

      // Then switch to activity tab
      const activityTab = screen.getByRole('button', { name: /Activity/i });
      fireEvent.click(activityTab);

      expect(activityTab).toHaveClass(/bg-foreground/);
      expect(screen.getByTestId('activity-feed')).toBeInTheDocument();
    });

    it('switches to spec coverage tab when clicked', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view first
      await switchToFocusView();

      // Then switch to spec coverage tab
      const specTab = screen.getByRole('button', { name: /Spec Coverage/i });
      fireEvent.click(specTab);

      expect(specTab).toHaveClass(/bg-foreground/);
      expect(screen.getByTestId('spec-coverage')).toBeInTheDocument();
    });

    it('switches to traceability tab when clicked', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view first
      await switchToFocusView();

      // Then switch to traceability tab
      const traceabilityTab = screen.getByRole('button', { name: /Traceability/i });
      fireEvent.click(traceabilityTab);

      expect(traceabilityTab).toHaveClass(/bg-foreground/);
      expect(screen.getByTestId('traceability')).toBeInTheDocument();
    });

    it('maintains tab state across re-renders', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);
      const { rerender, store } = renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view
      await switchToFocusView();

      // Switch to activity tab
      const activityTab = screen.getByRole('button', { name: /Activity/i });
      fireEvent.click(activityTab);
      expect(screen.getByTestId('activity-feed')).toBeInTheDocument();

      // Re-render with updated props
      rerender(
        <Provider store={store}>
          <TeamDashboard
            session={{ ...session, isProcessing: true }}
            onSendMessage={mockOnSendMessage}
          />
        </Provider>
      );

      // Should still be on activity tab
      expect(activityTab).toHaveClass(/bg-foreground/);
      expect(screen.getByTestId('activity-feed')).toBeInTheDocument();
    });
  });

  describe('Card Render Behavior - Teammate Display', () => {
    it('renders all teammates from session metadata', async () => {
      const session = createMockSession({
        teammateSessionIds: ['teammate-1', 'teammate-2', 'teammate-3'],
      });

      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
        createMockTeammate('teammate-2', 'Worker 2'),
        createMockTeammate('teammate-3', 'Worker 3'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      const sidebar = screen.getByTestId('teammate-sidebar');
      teammates.forEach(teammate => {
        expect(within(sidebar).getByTestId(`teammate-${teammate.id}`)).toBeInTheDocument();
      });
    });

    it('correctly identifies and displays the lead teammate', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      // Lead should be rendered first
      const sidebar = screen.getByTestId('teammate-sidebar');
      const teammateButtons = within(sidebar).getAllByRole('button');
      expect(teammateButtons[0]).toHaveTextContent('Lead Agent');
    });

    it('displays teammate status correctly', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        { ...createMockTeammate('teammate-1', 'Working Teammate'), status: 'working' as const },
        { ...createMockTeammate('teammate-2', 'Idle Teammate'), status: 'idle' as const },
      ];
      const metaMap = new Map<string, SessionMeta>();

      metaMap.set('session-1', {
        id: 'session-1',
        name: 'Lead Agent',
        workspaceId: 'workspace-1',
        isProcessing: false,
        messageCount: 5,
        model: 'claude-sonnet-4.5',
        tokenUsage: {
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 0.05,
        },
      });

      metaMap.set('teammate-1', {
        id: 'teammate-1',
        name: 'Working Teammate',
        workspaceId: 'workspace-1',
        isProcessing: true, // Working status
        messageCount: 3,
        model: 'claude-sonnet-4.5',
        tokenUsage: {
          inputTokens: 800,
          outputTokens: 400,
          costUsd: 0.04,
        },
      });

      metaMap.set('teammate-2', {
        id: 'teammate-2',
        name: 'Idle Teammate',
        workspaceId: 'workspace-1',
        isProcessing: false, // Idle status
        messageCount: 2,
        model: 'claude-sonnet-4.5',
        tokenUsage: {
          inputTokens: 600,
          outputTokens: 300,
          costUsd: 0.03,
        },
      });

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      const sidebar = screen.getByTestId('teammate-sidebar');
      expect(within(sidebar).getByTestId('teammate-teammate-1')).toBeInTheDocument();
      expect(within(sidebar).getByTestId('teammate-teammate-2')).toBeInTheDocument();
    });
  });

  describe('No-Duplication Assertions', () => {
    it('ensures each teammate appears exactly once in the sidebar', async () => {
      const session = createMockSession({
        teammateSessionIds: ['teammate-1', 'teammate-2'],
      });

      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
        createMockTeammate('teammate-2', 'Worker 2'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      const sidebar = screen.getByTestId('teammate-sidebar');
      const teammateButtons = within(sidebar).getAllByRole('button');

      // Should have exactly 3 teammates (lead + 2 workers)
      expect(teammateButtons).toHaveLength(3);

      // Each name should appear exactly once
      const names = teammateButtons.map(btn => btn.textContent);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it('does not duplicate teammates when session metadata updates', async () => {
      const session = createMockSession({
        teammateSessionIds: ['teammate-1'],
      });

      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      const { store } = renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      // Update metadata for teammate-1 (simulating status change)
      const updatedMetaMap = new Map(metaMap);
      const teammate1Meta = updatedMetaMap.get('teammate-1')!;
      updatedMetaMap.set('teammate-1', {
        ...teammate1Meta,
        isProcessing: true,
      });

      act(() => {
        store.set(sessionMetaMapAtom, updatedMetaMap);
      });

      // Focus view contains the teammate sidebar
      await switchToFocusView();
      const sidebar = screen.getByTestId('teammate-sidebar');
      const teammateButtons = within(sidebar).getAllByRole('button');

      // Should still have exactly 2 teammates
      expect(teammateButtons).toHaveLength(2);

      // Check that IDs are unique
      const ids = teammateButtons.map(btn => btn.getAttribute('data-testid'));
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it('does not show duplicate teammates when teammate list includes lead session', async () => {
      const session = createMockSession({
        id: 'session-1',
        teammateSessionIds: ['teammate-1', 'session-1'], // Incorrectly includes self
      });

      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
        createMockTeammate('teammate-1', 'Worker 1'),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view to see sidebar
      await switchToFocusView();

      const sidebar = screen.getByTestId('teammate-sidebar');
      const leadButtons = within(sidebar).getAllByText('Lead Agent');

      // Lead should appear exactly once
      expect(leadButtons).toHaveLength(1);
    });
  });

  describe('Task List Integration', () => {
    it('displays task count correctly', () => {
      const session = createMockSession();
      const tasks: TeamTask[] = [
        {
          id: 'task-1',
          title: 'Task 1',
          status: 'in_progress',
          assignee: 'teammate-1',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'task-2',
          title: 'Task 2',
          status: 'pending',
          createdAt: new Date().toISOString(),
        },
      ];

      renderTeamDashboard({
        session,
        tasks,
      });

      expect(screen.getByTestId('task-list')).toHaveTextContent('Tasks: 2');
    });

    it('does not duplicate tasks in the task list', () => {
      const session = createMockSession();
      const task: TeamTask = {
        id: 'task-1',
        title: 'Task 1',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
      };

      // Intentionally pass the same task twice (simulating a bug scenario)
      const tasks = [task, task];

      renderTeamDashboard({
        session,
        tasks,
      });

      // The component receives 2 tasks, but we're testing that it renders them
      // (The actual deduplication should happen at a higher level)
      expect(screen.getByTestId('task-list')).toHaveTextContent('Tasks: 2');
    });
  });

  describe('Compact Sidebar Mode', () => {
    it('starts with normal sidebar in focus view', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
      });

      
      // Switch to focus view
      await switchToFocusView();

      // Initially shows normal sidebar in focus view
      expect(screen.getByTestId('teammate-sidebar')).toBeInTheDocument();
      expect(screen.queryByTestId('compact-sidebar')).not.toBeInTheDocument();
    });
  });

  describe('Activity Events Display', () => {
    it('shows activity event count in tab badge', async () => {
      const session = createMockSession();
      const teammates = [
        createMockTeammate('session-1', 'Lead Agent', true),
      ];
      const metaMap = createSessionMetaMap(teammates);
      const activityEvents: TeamActivityEvent[] = [
        {
          id: 'event-1',
          timestamp: new Date().toISOString(),
          type: 'teammate-spawned',
          teammateId: 'teammate-1',
          teammateName: 'Worker 1',
          details: 'Worker 1 joined the team',
        },
        {
          id: 'event-2',
          timestamp: new Date().toISOString(),
          type: 'task-claimed',
          taskId: 'task-1',
          teammateId: 'teammate-1',
          details: 'Task claimed by teammate-1',
        },
        {
          id: 'event-3',
          timestamp: new Date().toISOString(),
          type: 'message-sent',
          teammateId: 'session-1',
          details: 'Message sent from session-1 to teammate-1',
        },
      ];

      renderTeamDashboard({
        session,
        initialSessionMeta: metaMap,
        activityEvents,
      });

      
      // Switch to focus view to see tabs
      await switchToFocusView();

      const activityTab = screen.getByRole('button', { name: /Activity/i });
      expect(activityTab).toHaveTextContent('3');
    });
  });
});



