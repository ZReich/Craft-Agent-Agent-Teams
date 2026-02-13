/**
 * Full render test
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import * as matchers from '@testing-library/jest-dom/matchers';
import { render, screen } from '@testing-library/react';
import { Provider, createStore } from 'jotai';

// Extend expect with jest-dom matchers (in case setup file doesn't run first)
expect.extend(matchers);

// Mock all child components and hooks
vi.mock('../TeamHeader', () => ({ TeamHeader: () => null }));
vi.mock('../TeammateSidebar', () => ({ TeammateSidebar: () => null }));
vi.mock('../TeammateDetailView', () => ({ TeammateDetailView: () => null }));
vi.mock('../TeamActivityFeed', () => ({ TeamActivityFeed: () => null }));
vi.mock('../SpecCoveragePanel', () => ({ SpecCoveragePanel: () => null }));
vi.mock('../SpecTraceabilityPanel', () => ({ SpecTraceabilityPanel: () => null }));
vi.mock('../TaskListPanel', () => ({ TaskListPanel: () => null }));
vi.mock('../TeamCreationDialog', () => ({ TeamCreationDialog: () => null }));
vi.mock('../TeamSidebarCompact', () => ({ TeamSidebarCompact: () => null }));
vi.mock('../QualityGateReport', () => ({ QualityGateReport: () => null }));
vi.mock('../SpecChecklistModal', () => ({ SpecChecklistModal: () => null }));
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: {} },
}));
vi.mock('pdfjs-dist/build/pdf.mjs', () => ({}));

// CRITICAL: Mock the useTeamEvents hook to avoid massive import tree that crashes fork workers
vi.mock('@/hooks/useTeamEvents', () => ({
  useTeamStateSync: () => ({
    status: 'disconnected',
    lastEvent: null,
    sequence: 0,
    on: vi.fn(),
    off: vi.fn(),
    reconnect: vi.fn(),
    isSubscribed: false,
  }),
}));

if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = class {} as unknown as typeof DOMMatrix;
}

// Import after mocks
import { TeamDashboard } from '../TeamDashboard';
import { sessionMetaMapAtom } from '@/atoms/sessions';

describe('Render test', () => {
  it('can render empty state', () => {
    const store = createStore();
    render(
      <Provider store={store}>
        <TeamDashboard
          session={{
            id: 'session-1',
            workspaceId: 'workspace-1',
            workspaceName: 'Test',
            name: 'Test Session',
            messages: [],
            isProcessing: false,
            lastMessageAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          }}
          onSendMessage={vi.fn()}
        />
      </Provider>
    );

    expect(screen.getByText('No Active Team')).toBeInTheDocument();
  });
});
