import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('@sentry/electron/main', () => ({
  init: () => undefined,
  captureException: () => undefined,
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => Promise.resolve({ messages: [] }),
  createSdkMcpServer: () => ({}),
  tool: () => ({}),
  AbortError: class AbortError extends Error {},
}));

import { SessionManager, buildTeammatePromptWithCompactSpec } from '../sessions';

describe('SDD auto-spec + compact-spec', () => {
  it('creates an active spec when missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-sdd-'));
    mkdirSync(join(root, 'sessions', 'test-session'), { recursive: true });
    const manager = new SessionManager();
    (manager as any).persistSession = () => {};
    (manager as any).startComplianceWatcher = async () => {};

    const sessionId = 'test-session';
    const managed = {
      id: sessionId,
      name: 'Test Session',
      workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: root },
      sddEnabled: true,
      activeSpecId: undefined,
      messages: [],
      lastMessageAt: Date.now(),
      permissionMode: 'safe',
      enabledSourceSlugs: [],
      hasUnread: false,
      isFlagged: false,
      isArchived: false,
      todoState: 'todo',
    } as any;

    (manager as any).sessions.set(sessionId, managed);

    try {
      const specId = await manager.ensureSessionActiveSpec(sessionId);
      expect(specId).toBeTruthy();
      expect(managed.activeSpecId).toBe(specId);
      expect(existsSync(specId!)).toBe(true);
      const content = readFileSync(specId!, 'utf-8');
      expect(content).toContain('## Requirements');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('appends compact spec context to teammate prompts', () => {
    const basePrompt = 'Do the thing';
    const compactSpec = '# Spec (Compact): Test\\n- REQ-001 something';
    const withSpec = buildTeammatePromptWithCompactSpec(basePrompt, compactSpec);
    expect(withSpec).toContain('<compact_spec>');
    expect(withSpec).toContain(compactSpec);
    expect(withSpec).toContain('TEAM COMPLETION PROTOCOL (MANDATORY)');
    expect(withSpec).toContain('recipient "team-lead"');

    const withoutSpec = buildTeammatePromptWithCompactSpec(basePrompt, null);
    expect(withoutSpec).toContain(basePrompt);
    expect(withoutSpec).toContain('TEAM COMPLETION PROTOCOL (MANDATORY)');
  });

  it('injects tool budgets into teammate prompts (REQ-BUDGET-003)', () => {
    const basePrompt = 'Research restaurants';
    const budgets = { WebSearch: 7, Read: 20, _default: 15 };
    const prompt = buildTeammatePromptWithCompactSpec(basePrompt, null, budgets);

    expect(prompt).toContain('TOOL BUDGETS (HARD LIMITS)');
    expect(prompt).toContain('WebSearch: 7 calls');
    expect(prompt).toContain('Read: 20 calls');
    expect(prompt).toContain('All other tools: 15 calls');
    expect(prompt).toContain('make each call count');
    // Completion protocol still present
    expect(prompt).toContain('TEAM COMPLETION PROTOCOL (MANDATORY)');
  });

  it('omits budget section when no budgets provided', () => {
    const prompt = buildTeammatePromptWithCompactSpec('Do work', null);
    expect(prompt).not.toContain('TOOL BUDGETS');
    expect(prompt).toContain('TEAM COMPLETION PROTOCOL (MANDATORY)');
  });
});
