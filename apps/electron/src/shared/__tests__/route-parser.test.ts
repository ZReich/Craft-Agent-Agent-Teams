/**
 * Route Parser Tests
 *
 * Comprehensive tests for route parsing, building, and roundtrip identity.
 * Covers:
 * - parseCompoundRoute / buildCompoundRoute roundtrip
 * - parseRouteToNavigationState / buildRouteFromNavigationState roundtrip
 * - Focus mode routes with team/teammate context
 * - Edge cases: empty params, malformed routes, missing IDs
 * - Right sidebar param parsing/building
 * - Query parameter handling for focus view transitions
 */

import { describe, it, expect } from 'bun:test';
import {
  isCompoundRoute,
  parseCompoundRoute,
  buildCompoundRoute,
  parseRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
  parseRightSidebarParam,
  buildRightSidebarParam,
  buildUrlWithState,
  type ParsedCompoundRoute,
  type NavigatorType,
} from '../route-parser';
import type { NavigationState, RightSidebarPanel } from '../types';

// ============================================================
// Compound Route Identification
// ============================================================

describe('isCompoundRoute', () => {
  it('identifies session filter routes', () => {
    expect(isCompoundRoute('allSessions')).toBe(true);
    expect(isCompoundRoute('flagged')).toBe(true);
    expect(isCompoundRoute('archived')).toBe(true);
    expect(isCompoundRoute('state/active')).toBe(true);
    expect(isCompoundRoute('label/bug')).toBe(true);
    expect(isCompoundRoute('view/myview')).toBe(true);
  });

  it('identifies navigator routes', () => {
    expect(isCompoundRoute('sources')).toBe(true);
    expect(isCompoundRoute('skills')).toBe(true);
    expect(isCompoundRoute('settings')).toBe(true);
    expect(isCompoundRoute('focus')).toBe(true);
  });

  it('rejects action routes', () => {
    expect(isCompoundRoute('action/new-session')).toBe(false);
  });

  it('rejects unknown prefixes', () => {
    expect(isCompoundRoute('unknown/path')).toBe(false);
    expect(isCompoundRoute('random')).toBe(false);
  });

  it('handles empty string', () => {
    expect(isCompoundRoute('')).toBe(false);
  });
});

// ============================================================
// Compound Route Parsing
// ============================================================

describe('parseCompoundRoute', () => {
  describe('sessions navigator', () => {
    it('parses allSessions', () => {
      const result = parseCompoundRoute('allSessions');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'allSessions' },
        details: null,
      });
    });

    it('parses flagged', () => {
      const result = parseCompoundRoute('flagged');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'flagged' },
        details: null,
      });
    });

    it('parses archived', () => {
      const result = parseCompoundRoute('archived');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'archived' },
        details: null,
      });
    });

    it('parses state filter with stateId', () => {
      const result = parseCompoundRoute('state/active');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sessions');
      expect(result!.sessionFilter).toEqual({ kind: 'state', stateId: 'active' });
    });

    it('parses label filter with labelId', () => {
      const result = parseCompoundRoute('label/bug');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sessions');
      expect(result!.sessionFilter).toEqual({ kind: 'label', labelId: 'bug' });
    });

    it('parses view filter with viewId', () => {
      const result = parseCompoundRoute('view/myview');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sessions');
      expect(result!.sessionFilter).toEqual({ kind: 'view', viewId: 'myview' });
    });

    it('parses session with details', () => {
      const result = parseCompoundRoute('allSessions/session/abc123');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'allSessions' },
        details: { type: 'session', id: 'abc123' },
      });
    });

    it('parses flagged session with details', () => {
      const result = parseCompoundRoute('flagged/session/def456');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'flagged' },
        details: { type: 'session', id: 'def456' },
      });
    });

    it('parses state filter with session details', () => {
      const result = parseCompoundRoute('state/active/session/xyz789');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'state', stateId: 'active' },
        details: { type: 'session', id: 'xyz789' },
      });
    });

    it('parses label filter with session details', () => {
      const result = parseCompoundRoute('label/bug/session/sess1');
      expect(result).toEqual({
        navigator: 'sessions',
        sessionFilter: { kind: 'label', labelId: 'bug' },
        details: { type: 'session', id: 'sess1' },
      });
    });

    it('returns null for state without stateId', () => {
      expect(parseCompoundRoute('state')).toBeNull();
    });

    it('returns null for label without labelId', () => {
      expect(parseCompoundRoute('label')).toBeNull();
    });

    it('returns null for view without viewId', () => {
      expect(parseCompoundRoute('view')).toBeNull();
    });
  });

  describe('sources navigator', () => {
    it('parses sources root', () => {
      const result = parseCompoundRoute('sources');
      expect(result).toEqual({ navigator: 'sources', details: null });
    });

    it('parses sources with type filter - api', () => {
      const result = parseCompoundRoute('sources/api');
      expect(result).toEqual({
        navigator: 'sources',
        sourceFilter: { kind: 'type', sourceType: 'api' },
        details: null,
      });
    });

    it('parses sources with type filter - mcp', () => {
      const result = parseCompoundRoute('sources/mcp');
      expect(result).toEqual({
        navigator: 'sources',
        sourceFilter: { kind: 'type', sourceType: 'mcp' },
        details: null,
      });
    });

    it('parses sources with type filter - local', () => {
      const result = parseCompoundRoute('sources/local');
      expect(result).toEqual({
        navigator: 'sources',
        sourceFilter: { kind: 'type', sourceType: 'local' },
        details: null,
      });
    });

    it('parses source selection without filter', () => {
      const result = parseCompoundRoute('sources/source/github');
      expect(result).toEqual({
        navigator: 'sources',
        details: { type: 'source', id: 'github' },
      });
    });

    it('parses filtered source selection', () => {
      const result = parseCompoundRoute('sources/api/source/gmail');
      expect(result).toEqual({
        navigator: 'sources',
        sourceFilter: { kind: 'type', sourceType: 'api' },
        details: { type: 'source', id: 'gmail' },
      });
    });

    it('returns null for invalid source path', () => {
      expect(parseCompoundRoute('sources/invalid')).toBeNull();
    });

    it('returns null for source without slug', () => {
      expect(parseCompoundRoute('sources/source')).toBeNull();
    });
  });

  describe('skills navigator', () => {
    it('parses skills root', () => {
      const result = parseCompoundRoute('skills');
      expect(result).toEqual({ navigator: 'skills', details: null });
    });

    it('parses skill selection', () => {
      const result = parseCompoundRoute('skills/skill/my-skill');
      expect(result).toEqual({
        navigator: 'skills',
        details: { type: 'skill', id: 'my-skill' },
      });
    });

    it('returns null for skill without slug', () => {
      expect(parseCompoundRoute('skills/skill')).toBeNull();
    });

    it('returns null for invalid skills path', () => {
      expect(parseCompoundRoute('skills/invalid')).toBeNull();
    });
  });

  describe('settings navigator', () => {
    it('parses settings root as app subpage', () => {
      const result = parseCompoundRoute('settings');
      expect(result).toEqual({
        navigator: 'settings',
        details: { type: 'app', id: 'app' },
      });
    });

    it('parses settings subpages', () => {
      const subpages = ['app', 'ai', 'appearance', 'input', 'workspace', 'permissions', 'labels', 'shortcuts', 'preferences', 'agent-teams', 'usage'];
      for (const subpage of subpages) {
        const result = parseCompoundRoute(`settings/${subpage}`);
        expect(result).not.toBeNull();
        expect(result!.navigator).toBe('settings');
        expect(result!.details).toEqual({ type: subpage, id: subpage });
      }
    });

    it('returns null for invalid settings subpage', () => {
      expect(parseCompoundRoute('settings/nonexistent')).toBeNull();
    });
  });

  describe('focus navigator', () => {
    it('parses focus with session', () => {
      const result = parseCompoundRoute('focus/session/sess-123');
      expect(result).toEqual({
        navigator: 'focus',
        details: { type: 'session', id: 'sess-123' },
      });
    });

    it('returns null for focus without session', () => {
      expect(parseCompoundRoute('focus')).toBeNull();
    });

    it('returns null for focus with invalid path', () => {
      expect(parseCompoundRoute('focus/invalid')).toBeNull();
    });

    it('returns null for focus/session without id', () => {
      expect(parseCompoundRoute('focus/session')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseCompoundRoute('')).toBeNull();
    });

    it('returns null for unknown prefix', () => {
      expect(parseCompoundRoute('unknown')).toBeNull();
    });

    it('handles URL-encoded label IDs', () => {
      const result = parseCompoundRoute('label/my%20label');
      expect(result).not.toBeNull();
      expect(result!.sessionFilter).toEqual({ kind: 'label', labelId: 'my label' });
    });

    it('handles URL-encoded view IDs', () => {
      const result = parseCompoundRoute('view/my%20view');
      expect(result).not.toBeNull();
      expect(result!.sessionFilter).toEqual({ kind: 'view', viewId: 'my view' });
    });
  });
});

// ============================================================
// Compound Route Building
// ============================================================

describe('buildCompoundRoute', () => {
  it('builds settings route', () => {
    expect(buildCompoundRoute({
      navigator: 'settings',
      details: { type: 'shortcuts', id: 'shortcuts' },
    })).toBe('settings/shortcuts');
  });

  it('builds settings route with default app', () => {
    expect(buildCompoundRoute({
      navigator: 'settings',
      details: null,
    })).toBe('settings/app');
  });

  it('builds sources root', () => {
    expect(buildCompoundRoute({
      navigator: 'sources',
      details: null,
    })).toBe('sources');
  });

  it('builds sources with filter', () => {
    expect(buildCompoundRoute({
      navigator: 'sources',
      sourceFilter: { kind: 'type', sourceType: 'api' },
      details: null,
    })).toBe('sources/api');
  });

  it('builds source selection without filter', () => {
    expect(buildCompoundRoute({
      navigator: 'sources',
      details: { type: 'source', id: 'github' },
    })).toBe('sources/source/github');
  });

  it('builds filtered source selection', () => {
    expect(buildCompoundRoute({
      navigator: 'sources',
      sourceFilter: { kind: 'type', sourceType: 'mcp' },
      details: { type: 'source', id: 'slack' },
    })).toBe('sources/mcp/source/slack');
  });

  it('builds skills root', () => {
    expect(buildCompoundRoute({
      navigator: 'skills',
      details: null,
    })).toBe('skills');
  });

  it('builds skill selection', () => {
    expect(buildCompoundRoute({
      navigator: 'skills',
      details: { type: 'skill', id: 'deploy' },
    })).toBe('skills/skill/deploy');
  });

  it('builds allSessions', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'allSessions' },
      details: null,
    })).toBe('allSessions');
  });

  it('builds flagged', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'flagged' },
      details: null,
    })).toBe('flagged');
  });

  it('builds archived', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'archived' },
      details: null,
    })).toBe('archived');
  });

  it('builds state filter', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'state', stateId: 'active' },
      details: null,
    })).toBe('state/active');
  });

  it('builds label filter with encoding', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'label', labelId: 'my label' },
      details: null,
    })).toBe('label/my%20label');
  });

  it('builds view filter with encoding', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'view', viewId: 'my view' },
      details: null,
    })).toBe('view/my%20view');
  });

  it('builds session with details', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      sessionFilter: { kind: 'allSessions' },
      details: { type: 'session', id: 'abc' },
    })).toBe('allSessions/session/abc');
  });

  it('defaults to allSessions when no filter', () => {
    expect(buildCompoundRoute({
      navigator: 'sessions',
      details: null,
    })).toBe('allSessions');
  });
});

// ============================================================
// Compound Route Roundtrip (parse -> build identity)
// ============================================================

describe('parseCompoundRoute -> buildCompoundRoute roundtrip', () => {
  const roundtripRoutes = [
    'allSessions',
    'flagged',
    'archived',
    'state/active',
    'label/bug',
    'view/myview',
    'allSessions/session/abc123',
    'flagged/session/def456',
    'state/active/session/xyz789',
    'label/bug/session/sess1',
    'view/myview/session/sess2',
    'sources',
    'sources/api',
    'sources/mcp',
    'sources/local',
    'sources/source/github',
    'sources/api/source/gmail',
    'skills',
    'skills/skill/deploy',
    'settings/app',
    'settings/shortcuts',
    'settings/agent-teams',
    'settings/usage',
  ];

  for (const route of roundtripRoutes) {
    it(`roundtrips: "${route}"`, () => {
      const parsed = parseCompoundRoute(route);
      expect(parsed).not.toBeNull();
      const rebuilt = buildCompoundRoute(parsed!);
      expect(rebuilt).toBe(route);
    });
  }

  it('roundtrips label with URL encoding', () => {
    const route = 'label/my%20label';
    const parsed = parseCompoundRoute(route);
    expect(parsed).not.toBeNull();
    const rebuilt = buildCompoundRoute(parsed!);
    expect(rebuilt).toBe(route);
  });
});

// ============================================================
// NavigationState Parsing
// ============================================================

describe('parseRouteToNavigationState', () => {
  describe('sessions routes', () => {
    it('parses allSessions to sessions state', () => {
      const result = parseRouteToNavigationState('allSessions');
      expect(result).toEqual({
        navigator: 'sessions',
        filter: { kind: 'allSessions' },
        details: null,
      });
    });

    it('parses session with details', () => {
      const result = parseRouteToNavigationState('allSessions/session/abc');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sessions');
      if (result!.navigator === 'sessions') {
        expect(result!.details).toEqual({ type: 'session', sessionId: 'abc' });
      }
    });
  });

  describe('focus routes', () => {
    it('parses focus session route', () => {
      const result = parseRouteToNavigationState('focus/session/sess-123');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('focus');
      if (result!.navigator === 'focus') {
        expect(result!.details).toEqual({ type: 'session', sessionId: 'sess-123' });
      }
    });

    it('parses focus with contextPane query param', () => {
      const result = parseRouteToNavigationState('focus/session/sess-123?contextPane=true');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('focus');
      if (result!.navigator === 'focus') {
        expect(result!.contextPaneVisible).toBe(true);
      }
    });

    it('parses focus with timeline query param', () => {
      const result = parseRouteToNavigationState('focus/session/sess-123?timeline=true');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('focus');
      if (result!.navigator === 'focus') {
        expect(result!.timelineDrawerVisible).toBe(true);
      }
    });

    it('parses focus with both query params', () => {
      const result = parseRouteToNavigationState('focus/session/sess-123?contextPane=true&timeline=true');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('focus');
      if (result!.navigator === 'focus') {
        expect(result!.contextPaneVisible).toBe(true);
        expect(result!.timelineDrawerVisible).toBe(true);
      }
    });

    it('handles focus with right sidebar param', () => {
      const result = parseRouteToNavigationState('focus/session/sess-123', 'sessionMetadata');
      expect(result).not.toBeNull();
      expect(result!.rightSidebar).toEqual({ type: 'sessionMetadata' });
    });

    it('returns sessions fallback for focus without session', () => {
      const result = parseRouteToNavigationState('focus');
      // focus without session parses to null from parseCompoundRoute,
      // but parseRoute also returns null for 'focus' alone (not compound route with details)
      // The compound parser returns null, then parseRoute returns null
      expect(result).toBeNull();
    });
  });

  describe('settings routes', () => {
    it('parses settings route', () => {
      const result = parseRouteToNavigationState('settings');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('settings');
      if (result!.navigator === 'settings') {
        expect(result!.subpage).toBe('app');
      }
    });

    it('parses settings subpage', () => {
      const result = parseRouteToNavigationState('settings/shortcuts');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('settings');
      if (result!.navigator === 'settings') {
        expect(result!.subpage).toBe('shortcuts');
      }
    });
  });

  describe('sources routes', () => {
    it('parses sources root', () => {
      const result = parseRouteToNavigationState('sources');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sources');
    });

    it('parses sources with filter', () => {
      const result = parseRouteToNavigationState('sources/api');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sources');
      if (result!.navigator === 'sources') {
        expect(result!.filter).toEqual({ kind: 'type', sourceType: 'api' });
      }
    });

    it('parses source selection', () => {
      const result = parseRouteToNavigationState('sources/source/github');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('sources');
      if (result!.navigator === 'sources') {
        expect(result!.details).toEqual({ type: 'source', sourceSlug: 'github' });
      }
    });
  });

  describe('skills routes', () => {
    it('parses skills root', () => {
      const result = parseRouteToNavigationState('skills');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('skills');
    });

    it('parses skill selection', () => {
      const result = parseRouteToNavigationState('skills/skill/my-skill');
      expect(result).not.toBeNull();
      expect(result!.navigator).toBe('skills');
      if (result!.navigator === 'skills') {
        expect(result!.details).toEqual({ type: 'skill', skillSlug: 'my-skill' });
      }
    });
  });

  describe('action routes', () => {
    it('returns null for action routes (no navigation state)', () => {
      const result = parseRouteToNavigationState('action/new-session');
      expect(result).toBeNull();
    });
  });

  describe('right sidebar param', () => {
    it('adds sidebar to any route', () => {
      const result = parseRouteToNavigationState('allSessions', 'sessionMetadata');
      expect(result).not.toBeNull();
      expect(result!.rightSidebar).toEqual({ type: 'sessionMetadata' });
    });

    it('ignores undefined sidebar param', () => {
      const result = parseRouteToNavigationState('allSessions');
      expect(result).not.toBeNull();
      expect(result!.rightSidebar).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('returns null for empty string', () => {
      expect(parseRouteToNavigationState('')).toBeNull();
    });

    it('returns null for completely invalid route', () => {
      expect(parseRouteToNavigationState('zzzz/invalid')).toBeNull();
    });

    it('returns null for malformed route', () => {
      expect(parseRouteToNavigationState('//')).toBeNull();
    });
  });
});

// ============================================================
// NavigationState Building
// ============================================================

describe('buildRouteFromNavigationState', () => {
  it('builds settings route', () => {
    const state: NavigationState = { navigator: 'settings', subpage: 'shortcuts' };
    expect(buildRouteFromNavigationState(state)).toBe('settings/shortcuts');
  });

  it('builds focus route', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'sess-123' },
    };
    expect(buildRouteFromNavigationState(state)).toBe('focus/session/sess-123');
  });

  it('builds focus route with context pane', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'sess-123' },
      contextPaneVisible: true,
    };
    expect(buildRouteFromNavigationState(state)).toBe('focus/session/sess-123?contextPane=true');
  });

  it('builds focus route with timeline', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'sess-123' },
      timelineDrawerVisible: true,
    };
    expect(buildRouteFromNavigationState(state)).toBe('focus/session/sess-123?timeline=true');
  });

  it('builds focus route with both params', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 's1' },
      contextPaneVisible: true,
      timelineDrawerVisible: true,
    };
    expect(buildRouteFromNavigationState(state)).toBe('focus/session/s1?contextPane=true&timeline=true');
  });

  it('builds sources root', () => {
    const state: NavigationState = { navigator: 'sources', details: null };
    expect(buildRouteFromNavigationState(state)).toBe('sources');
  });

  it('builds sources with filter', () => {
    const state: NavigationState = {
      navigator: 'sources',
      filter: { kind: 'type', sourceType: 'api' },
      details: null,
    };
    expect(buildRouteFromNavigationState(state)).toBe('sources/api');
  });

  it('builds source selection', () => {
    const state: NavigationState = {
      navigator: 'sources',
      details: { type: 'source', sourceSlug: 'github' },
    };
    expect(buildRouteFromNavigationState(state)).toBe('sources/source/github');
  });

  it('builds skills root', () => {
    const state: NavigationState = { navigator: 'skills', details: null };
    expect(buildRouteFromNavigationState(state)).toBe('skills');
  });

  it('builds skill selection', () => {
    const state: NavigationState = {
      navigator: 'skills',
      details: { type: 'skill', skillSlug: 'my-skill' },
    };
    expect(buildRouteFromNavigationState(state)).toBe('skills/skill/my-skill');
  });

  it('builds sessions with all filter types', () => {
    const filters: Array<{ filter: any; expected: string }> = [
      { filter: { kind: 'allSessions' }, expected: 'allSessions' },
      { filter: { kind: 'flagged' }, expected: 'flagged' },
      { filter: { kind: 'archived' }, expected: 'archived' },
      { filter: { kind: 'state', stateId: 'active' }, expected: 'state/active' },
      { filter: { kind: 'label', labelId: 'bug' }, expected: 'label/bug' },
      { filter: { kind: 'view', viewId: 'myview' }, expected: 'view/myview' },
    ];

    for (const { filter, expected } of filters) {
      const state: NavigationState = { navigator: 'sessions', filter, details: null };
      expect(buildRouteFromNavigationState(state)).toBe(expected);
    }
  });

  it('builds session with details', () => {
    const state: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: { type: 'session', sessionId: 'abc' },
    };
    expect(buildRouteFromNavigationState(state)).toBe('allSessions/session/abc');
  });
});

// ============================================================
// NavigationState Roundtrip (parse -> build identity)
// ============================================================

describe('parseRouteToNavigationState -> buildRouteFromNavigationState roundtrip', () => {
  const roundtripRoutes = [
    'allSessions',
    'flagged',
    'archived',
    'state/active',
    'label/bug',
    'view/myview',
    'allSessions/session/abc123',
    'flagged/session/def456',
    'sources',
    'sources/api',
    'sources/mcp',
    'sources/local',
    'sources/source/github',
    'skills',
    'skills/skill/deploy',
    'settings/app',
    'settings/shortcuts',
    'settings/agent-teams',
    'focus/session/sess-123',
    'focus/session/sess-123?contextPane=true',
    'focus/session/sess-123?timeline=true',
    'focus/session/sess-123?contextPane=true&timeline=true',
  ];

  for (const route of roundtripRoutes) {
    it(`roundtrips: "${route}"`, () => {
      const state = parseRouteToNavigationState(route);
      expect(state).not.toBeNull();
      const rebuilt = buildRouteFromNavigationState(state!);
      expect(rebuilt).toBe(route);
    });
  }
});

// ============================================================
// parseRoute (legacy route format)
// ============================================================

describe('parseRoute', () => {
  it('parses action routes', () => {
    const result = parseRoute('action/new-session');
    expect(result).toEqual({
      type: 'action',
      name: 'new-session',
      id: undefined,
      params: {},
    });
  });

  it('parses action routes with id', () => {
    const result = parseRoute('action/edit/123');
    expect(result).toEqual({
      type: 'action',
      name: 'edit',
      id: '123',
      params: {},
    });
  });

  it('parses action routes with query params', () => {
    const result = parseRoute('action/new-session?workspace=ws1');
    expect(result).not.toBeNull();
    expect(result!.params).toEqual({ workspace: 'ws1' });
  });

  it('converts compound routes to view type', () => {
    const result = parseRoute('allSessions');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('view');
    expect(result!.name).toBe('allSessions');
  });

  it('converts focus compound route to view', () => {
    const result = parseRoute('focus/session/sess-1');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('view');
  });

  it('returns null for empty segments', () => {
    expect(parseRoute('')).toBeNull();
  });

  it('returns null for single non-compound segment', () => {
    expect(parseRoute('action')).toBeNull();
  });

  it('returns null for non-action, non-compound route', () => {
    expect(parseRoute('random/path')).toBeNull();
  });
});

// ============================================================
// Right Sidebar Param Parsing
// ============================================================

describe('parseRightSidebarParam', () => {
  it('returns undefined for no param', () => {
    expect(parseRightSidebarParam()).toBeUndefined();
    expect(parseRightSidebarParam(undefined)).toBeUndefined();
  });

  it('parses sessionMetadata', () => {
    expect(parseRightSidebarParam('sessionMetadata')).toEqual({ type: 'sessionMetadata' });
  });

  it('parses history', () => {
    expect(parseRightSidebarParam('history')).toEqual({ type: 'history' });
  });

  it('parses files without path', () => {
    expect(parseRightSidebarParam('files')).toEqual({ type: 'files', path: undefined });
  });

  it('parses files with path', () => {
    expect(parseRightSidebarParam('files/src/main.ts')).toEqual({ type: 'files', path: 'src/main.ts' });
  });

  it('parses none', () => {
    expect(parseRightSidebarParam('none')).toEqual({ type: 'none' });
  });

  it('returns undefined for unknown param', () => {
    expect(parseRightSidebarParam('unknown')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(parseRightSidebarParam('')).toBeUndefined();
  });
});

// ============================================================
// Right Sidebar Param Building
// ============================================================

describe('buildRightSidebarParam', () => {
  it('returns undefined for no panel', () => {
    expect(buildRightSidebarParam()).toBeUndefined();
    expect(buildRightSidebarParam(undefined)).toBeUndefined();
  });

  it('returns undefined for none type', () => {
    expect(buildRightSidebarParam({ type: 'none' })).toBeUndefined();
  });

  it('builds sessionMetadata', () => {
    expect(buildRightSidebarParam({ type: 'sessionMetadata' })).toBe('sessionMetadata');
  });

  it('builds history', () => {
    expect(buildRightSidebarParam({ type: 'history' })).toBe('history');
  });

  it('builds files without path', () => {
    expect(buildRightSidebarParam({ type: 'files' })).toBe('files');
  });

  it('builds files with path', () => {
    expect(buildRightSidebarParam({ type: 'files', path: 'src/main.ts' })).toBe('files/src/main.ts');
  });
});

// ============================================================
// Right Sidebar Roundtrip
// ============================================================

describe('parseRightSidebarParam -> buildRightSidebarParam roundtrip', () => {
  const roundtripParams = [
    'sessionMetadata',
    'history',
    'files',
    'files/src/main.ts',
  ];

  for (const param of roundtripParams) {
    it(`roundtrips: "${param}"`, () => {
      const parsed = parseRightSidebarParam(param);
      expect(parsed).toBeDefined();
      const rebuilt = buildRightSidebarParam(parsed!);
      expect(rebuilt).toBe(param);
    });
  }
});

// ============================================================
// buildUrlWithState
// ============================================================

describe('buildUrlWithState', () => {
  it('builds URL with route param', () => {
    const state: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: null,
    };
    const url = buildUrlWithState(state);
    expect(url).toContain('route=allSessions');
  });

  it('builds URL with sidebar param', () => {
    const state: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: null,
      rightSidebar: { type: 'sessionMetadata' },
    };
    const url = buildUrlWithState(state);
    expect(url).toContain('route=allSessions');
    expect(url).toContain('sidebar=sessionMetadata');
  });

  it('omits sidebar for none type', () => {
    const state: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: null,
      rightSidebar: { type: 'none' },
    };
    const url = buildUrlWithState(state);
    expect(url).not.toContain('sidebar');
  });

  it('builds focus URL with query params', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 's1' },
      contextPaneVisible: true,
    };
    const url = buildUrlWithState(state);
    // The route itself contains the query params for focus
    expect(url).toContain('contextPane');
  });
});

// ============================================================
// Team Dashboard Focus Routes
// ============================================================

describe('team-specific focus routes', () => {
  it('supports focus route for team dashboard session context', () => {
    // Focus mode is used when viewing a specific session in full-screen mode
    // This is relevant for team dashboard where you focus on a team lead session
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'team-lead-session-123' },
      contextPaneVisible: true,
      timelineDrawerVisible: true,
    };

    const route = buildRouteFromNavigationState(state);
    expect(route).toBe('focus/session/team-lead-session-123?contextPane=true&timeline=true');

    const parsed = parseRouteToNavigationState(route);
    expect(parsed).not.toBeNull();
    expect(parsed!.navigator).toBe('focus');
    if (parsed!.navigator === 'focus') {
      expect(parsed!.details.sessionId).toBe('team-lead-session-123');
      expect(parsed!.contextPaneVisible).toBe(true);
      expect(parsed!.timelineDrawerVisible).toBe(true);
    }
  });

  it('supports focus view transition without query params', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'sess-abc' },
    };

    const route = buildRouteFromNavigationState(state);
    expect(route).toBe('focus/session/sess-abc');

    const parsed = parseRouteToNavigationState(route);
    expect(parsed).not.toBeNull();
    expect(parsed!.navigator).toBe('focus');
  });

  it('transitions from sessions to focus view (navigation flow)', () => {
    // Start at sessions view
    const sessionsState: NavigationState = {
      navigator: 'sessions',
      filter: { kind: 'allSessions' },
      details: { type: 'session', sessionId: 'sess-1' },
    };

    const sessionsRoute = buildRouteFromNavigationState(sessionsState);
    expect(sessionsRoute).toBe('allSessions/session/sess-1');

    // Transition to focus view for the same session
    const focusState: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'sess-1' },
    };

    const focusRoute = buildRouteFromNavigationState(focusState);
    expect(focusRoute).toBe('focus/session/sess-1');

    // Verify both routes parse correctly
    const parsedSessions = parseRouteToNavigationState(sessionsRoute);
    const parsedFocus = parseRouteToNavigationState(focusRoute);

    expect(parsedSessions).not.toBeNull();
    expect(parsedFocus).not.toBeNull();
    expect(parsedSessions!.navigator).toBe('sessions');
    expect(parsedFocus!.navigator).toBe('focus');
  });

  it('handles focus route with right sidebar for team context', () => {
    const state: NavigationState = {
      navigator: 'focus',
      details: { type: 'session', sessionId: 'team-sess' },
      rightSidebar: { type: 'sessionMetadata' },
    };

    // The route build doesn't include sidebar (that goes in URL params)
    const route = buildRouteFromNavigationState(state);
    expect(route).toBe('focus/session/team-sess');

    // But buildUrlWithState includes it
    const url = buildUrlWithState(state);
    expect(url).toContain('sidebar=sessionMetadata');
  });
});
