/**
 * Regression test for session header buffer overflow (REQ-FIX-001, REQ-FIX-002).
 *
 * Agent team sessions with SDD enabled accumulate sddComplianceReports in the
 * session header. When the header exceeds the read buffer size, the session
 * silently disappears from the session list on app restart.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSessionHeader, readSessionHeaderAsync, createSessionHeader } from '../jsonl';
import type { StoredSession } from '../types';

// Helper: generate a realistic compliance report (~970 bytes each)
function makeComplianceReport(index: number) {
  return {
    specId: `/path/to/spec/2026-02-17-spec.md`,
    timestamp: new Date(Date.now() - index * 60_000).toISOString(),
    overallCoverage: 50,
    requirementsCoverage: [
      { requirementId: 'REQ-001', coverage: 'partial', referencedInFiles: [], referencedInTests: [], notes: '4 task(s)' },
      { requirementId: 'REQ-002', coverage: 'partial', referencedInFiles: [], referencedInTests: [], notes: '4 task(s)' },
      { requirementId: 'REQ-003', coverage: 'partial', referencedInFiles: [], referencedInTests: [], notes: '4 task(s)' },
    ],
    unreferencedRequirements: [],
    traceabilityMap: [
      { requirementId: 'REQ-001', files: [], tests: [], tasks: ['task-aaaa', 'task-bbbb', 'task-cccc', 'task-dddd'], tickets: [] },
      { requirementId: 'REQ-002', files: [], tests: [], tasks: ['task-aaaa', 'task-bbbb', 'task-cccc', 'task-dddd'], tickets: [] },
      { requirementId: 'REQ-003', files: [], tests: [], tasks: ['task-aaaa', 'task-bbbb', 'task-cccc', 'task-dddd'], tickets: [] },
    ],
    rolloutSafetyCheck: {
      hasRollbackPlan: true,
      hasMonitoring: true,
      hasFeatureFlags: false,
      issues: ['No feature-flag strategy detected'],
    },
  };
}

// Helper: create a minimal session header object
function makeHeader(overrides: Record<string, unknown> = {}) {
  return {
    id: '260216-test-session',
    workspaceRootPath: '/tmp/test-workspace',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    messageCount: 5,
    isTeamLead: true,
    teamId: 'test-team',
    teammateSessionIds: ['260216-worker-1', '260216-worker-2'],
    teamColor: '#0891b2',
    permissionMode: 'allow-all',
    ...overrides,
  };
}

describe('readSessionHeader — oversized header handling (REQ-FIX-001)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'jsonl-header-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('reads a normal header within 8KB', () => {
    const header = makeHeader();
    const sessionDir = join(testDir, 'normal-session');
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionFile, JSON.stringify(header) + '\n{"type":"user","content":"hello"}\n');

    const result = readSessionHeader(sessionFile);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('260216-test-session');
    expect(result!.isTeamLead).toBe(true);
  });

  it('reads a header that exceeds 8KB due to many compliance reports', () => {
    // 15 reports × ~970 bytes ≈ 14.5KB — well above the old 8KB limit
    const reports = Array.from({ length: 15 }, (_, i) => makeComplianceReport(i));
    const header = makeHeader({ sddComplianceReports: reports, sddEnabled: true });
    const headerJson = JSON.stringify(header);

    // Verify our test setup: header must be larger than 8KB
    expect(headerJson.length).toBeGreaterThan(8192);

    const sessionDir = join(testDir, 'large-session');
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionFile, headerJson + '\n{"type":"user","content":"hello"}\n');

    const result = readSessionHeader(sessionFile);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('260216-test-session');
    expect(result!.isTeamLead).toBe(true);
    expect(result!.sddEnabled).toBe(true);
    expect(result!.sddComplianceReports).toHaveLength(15);
  });

  it('reads a header that exceeds 8KB via async reader', async () => {
    const reports = Array.from({ length: 15 }, (_, i) => makeComplianceReport(i));
    const header = makeHeader({ sddComplianceReports: reports, sddEnabled: true });
    const headerJson = JSON.stringify(header);

    expect(headerJson.length).toBeGreaterThan(8192);

    const sessionDir = join(testDir, 'large-async');
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionFile, headerJson + '\n');

    const result = await readSessionHeaderAsync(sessionFile);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('260216-test-session');
    expect(result!.sddComplianceReports).toHaveLength(15);
  });

  it('handles a single-line file (no trailing newline)', () => {
    const header = makeHeader();
    const sessionDir = join(testDir, 'no-newline');
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'session.jsonl');
    writeFileSync(sessionFile, JSON.stringify(header));

    const result = readSessionHeader(sessionFile);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('260216-test-session');
  });
});

describe('createSessionHeader — compliance report cap (REQ-FIX-002)', () => {
  it('caps sddComplianceReports to last 5 entries', () => {
    const reports = Array.from({ length: 12 }, (_, i) => makeComplianceReport(i));
    const session = {
      id: '260216-test',
      workspaceRootPath: '/tmp/test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      sddEnabled: true,
      sddComplianceReports: reports,
    } as unknown as StoredSession;

    const header = createSessionHeader(session);

    // Should keep only the last 5
    expect(header.sddComplianceReports).toHaveLength(5);
    // Should be the most recent 5 (last 5 from the array)
    expect(header.sddComplianceReports![0]).toEqual(reports[7]);
    expect(header.sddComplianceReports![4]).toEqual(reports[11]);
  });

  it('leaves reports untouched when 5 or fewer', () => {
    const reports = Array.from({ length: 3 }, (_, i) => makeComplianceReport(i));
    const session = {
      id: '260216-test',
      workspaceRootPath: '/tmp/test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
      sddEnabled: true,
      sddComplianceReports: reports,
    } as unknown as StoredSession;

    const header = createSessionHeader(session);
    expect(header.sddComplianceReports).toHaveLength(3);
  });

  it('handles sessions without compliance reports', () => {
    const session = {
      id: '260216-test',
      workspaceRootPath: '/tmp/test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [],
    } as unknown as StoredSession;

    const header = createSessionHeader(session);
    expect(header.sddComplianceReports).toBeUndefined();
  });
});
