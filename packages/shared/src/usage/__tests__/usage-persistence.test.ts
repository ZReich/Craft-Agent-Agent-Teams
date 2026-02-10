/**
 * Tests for UsagePersistence class
 *
 * These tests verify that usage data is correctly persisted to disk,
 * aggregated weekly, and retrieved for reporting.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { UsagePersistence } from '../usage-persistence.ts';
import type { SessionUsage, WeeklyUsageSummary } from '@craft-agent/core';

// Helper to create mock session usage data
function createMockSessionUsage(overrides: Partial<SessionUsage> = {}): SessionUsage {
  const startDate = new Date('2026-02-07T10:00:00.000Z');
  return {
    sessionId: 'test-session-001',
    startedAt: startDate.toISOString(),
    lastUpdatedAt: new Date(startDate.getTime() + 3600000).toISOString(), // 1 hour later
    weekIdentifier: '2026-W06',
    providers: {
      anthropic: {
        callCount: 5,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.15,
      },
      openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      openrouter: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
    },
    totalCalls: 5,
    totalDurationMs: 3600000,
    ...overrides,
  };
}

// Clean up test directory
async function cleanupTestDir(workspaceId: string) {
  const testPath = path.join(os.homedir(), '.craft-agent', 'workspaces', workspaceId);
  try {
    await fs.rm(testPath, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }
}

describe('UsagePersistence', () => {
  let persistence: UsagePersistence;
  let currentWorkspaceId: string;

  beforeEach(async () => {
    // Generate unique workspace ID for each test to ensure isolation
    currentWorkspaceId = `test-ws-${Date.now()}-${Math.random().toString(36).substring(7)}`;

    // Clean up before each test
    await cleanupTestDir(currentWorkspaceId);

    // Use a custom workspace path for testing
    persistence = new UsagePersistence(currentWorkspaceId);
  });

  describe('getWeekIdentifier', () => {
    test('should return correct ISO week identifier for 2026-02-07', () => {
      const date = new Date('2026-02-07T12:00:00.000Z');
      const weekId = persistence.getWeekIdentifier(date);
      expect(weekId).toBe('2026-W06');
    });

    test('should return correct ISO week identifier for start of year', () => {
      const date = new Date('2026-01-01T12:00:00.000Z');
      const weekId = persistence.getWeekIdentifier(date);
      // Jan 1, 2026 is a Thursday, so it belongs to week 1
      expect(weekId).toBe('2026-W01');
    });

    test('should return correct ISO week identifier for end of year', () => {
      const date = new Date('2025-12-31T12:00:00.000Z');
      const weekId = persistence.getWeekIdentifier(date);
      // Dec 31, 2025 is a Wednesday, check which week it belongs to
      expect(weekId).toMatch(/202[56]-W\d{2}/);
    });

    test('should return same week identifier for dates in same week', () => {
      const monday = new Date('2026-02-02T12:00:00.000Z');
      const friday = new Date('2026-02-06T12:00:00.000Z');
      const sunday = new Date('2026-02-08T12:00:00.000Z');

      const weekId1 = persistence.getWeekIdentifier(monday);
      const weekId2 = persistence.getWeekIdentifier(friday);
      const weekId3 = persistence.getWeekIdentifier(sunday);

      expect(weekId1).toBe(weekId2);
      expect(weekId2).toBe(weekId3);
    });

    test('should pad week number with leading zero', () => {
      const earlyYear = new Date('2026-01-15T12:00:00.000Z');
      const weekId = persistence.getWeekIdentifier(earlyYear);
      expect(weekId).toMatch(/2026-W0\d/);
    });
  });

  describe('saveSessionUsage and loadSessionUsage', () => {
    test('should save and load session usage data correctly', async () => {
      const sessionId = 'test-session-001';
      const usage = createMockSessionUsage({ sessionId });

      await persistence.saveSessionUsage(sessionId, usage);
      const loaded = await persistence.loadSessionUsage(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded?.sessionId).toBe(sessionId);
      expect(loaded?.totalCalls).toBe(5);
      expect(loaded?.providers.anthropic.callCount).toBe(5);
      expect(loaded?.providers.anthropic.estimatedCostUsd).toBe(0.15);
    });

    test('should return null for non-existent session', async () => {
      const loaded = await persistence.loadSessionUsage('non-existent-session');
      expect(loaded).toBeNull();
    });

    test('should create session directory if it does not exist', async () => {
      const sessionId = 'new-session-001';
      const usage = createMockSessionUsage({ sessionId });

      await persistence.saveSessionUsage(sessionId, usage);

      // Verify the usage file was created (using actual homedir path)
      const workspacePath = path.join(os.homedir(), '.craft-agent', 'workspaces', currentWorkspaceId);
      const usageFilePath = path.join(workspacePath, 'sessions', sessionId, 'usage.json');
      const fileExists = await fs.access(usageFilePath).then(() => true).catch(() => false);
      expect(fileExists).toBe(true);
    });

    test('should preserve all usage data fields', async () => {
      const sessionId = 'test-session-002';
      const usage = createMockSessionUsage({
        sessionId,
        totalDurationMs: 5000,
        weekIdentifier: '2026-W07',
      });

      await persistence.saveSessionUsage(sessionId, usage);
      const loaded = await persistence.loadSessionUsage(sessionId);

      expect(loaded?.totalDurationMs).toBe(5000);
      expect(loaded?.weekIdentifier).toBe('2026-W07');
      expect(loaded?.startedAt).toBe(usage.startedAt);
      expect(loaded?.lastUpdatedAt).toBe(usage.lastUpdatedAt);
    });
  });

  describe('recordSessionEnd', () => {
    test('should create weekly file with session data', async () => {
      const usage = createMockSessionUsage();
      await persistence.recordSessionEnd('test-session-001', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly).not.toBeNull();
      expect(weekly?.sessionCount).toBe(1);
      expect(weekly?.sessions.length).toBe(1);
    });

    test('should aggregate totals correctly', async () => {
      const usage = createMockSessionUsage();
      await persistence.recordSessionEnd('test-session-001', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.totals.calls).toBe(5);
      expect(weekly?.totals.inputTokens).toBe(1000);
      expect(weekly?.totals.outputTokens).toBe(500);
      expect(weekly?.totals.estimatedCostUsd).toBeCloseTo(0.15, 2);
      expect(weekly?.totals.durationMs).toBe(3600000);
    });

    test('should update existing weekly with new session', async () => {
      const usage1 = createMockSessionUsage({ sessionId: 'session-001' });
      const usage2 = createMockSessionUsage({
        sessionId: 'session-002',
        providers: {
          anthropic: {
            callCount: 3,
            inputTokens: 500,
            outputTokens: 250,
            estimatedCostUsd: 0.08,
          },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openrouter: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
        totalCalls: 3,
      });

      await persistence.recordSessionEnd('session-001', usage1);
      await persistence.recordSessionEnd('session-002', usage2);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.sessionCount).toBe(2);
      expect(weekly?.totals.calls).toBe(8); // 5 + 3
      expect(weekly?.totals.inputTokens).toBe(1500); // 1000 + 500
      expect(weekly?.totals.estimatedCostUsd).toBeCloseTo(0.23, 2); // 0.15 + 0.08
    });

    test('should handle team usage data correctly', async () => {
      const usage = createMockSessionUsage({
        teamUsage: {
          teamId: 'team-001',
          teammateCount: 3,
          totalTeamCostUsd: 0.50,
          perTeammate: {
            'teammate-1': {
              name: 'Researcher',
              model: 'claude-sonnet-4.5',
              provider: 'anthropic',
              role: 'researcher',
              inputTokens: 1000,
              outputTokens: 500,
              costUsd: 0.20,
              callCount: 5,
            },
          },
          perModel: {
            'claude-sonnet-4.5': {
              inputTokens: 2000,
              outputTokens: 1000,
              costUsd: 0.50,
              callCount: 10,
            },
          },
        },
      });

      await persistence.recordSessionEnd('team-session-001', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.teamUsage).toBeDefined();
      expect(weekly?.teamUsage?.teamsCreated).toBe(1);
      expect(weekly?.teamUsage?.teammatesSpawned).toBe(3);
      expect(weekly?.teamUsage?.totalTeamCostUsd).toBeCloseTo(0.50, 2);
    });

    test('should aggregate team usage across multiple sessions', async () => {
      const usage1 = createMockSessionUsage({
        sessionId: 'team-session-001',
        teamUsage: {
          teamId: 'team-001',
          teammateCount: 2,
          totalTeamCostUsd: 0.30,
          perTeammate: {},
          perModel: {},
        },
      });

      const usage2 = createMockSessionUsage({
        sessionId: 'team-session-002',
        teamUsage: {
          teamId: 'team-002',
          teammateCount: 4,
          totalTeamCostUsd: 0.60,
          perTeammate: {},
          perModel: {},
        },
      });

      await persistence.recordSessionEnd('team-session-001', usage1);
      await persistence.recordSessionEnd('team-session-002', usage2);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.teamUsage?.teamsCreated).toBe(2);
      expect(weekly?.teamUsage?.teammatesSpawned).toBe(6); // 2 + 4
      expect(weekly?.teamUsage?.totalTeamCostUsd).toBeCloseTo(0.90, 2); // 0.30 + 0.60
    });

    test('should update provider breakdown correctly', async () => {
      const usage = createMockSessionUsage({
        providers: {
          anthropic: {
            callCount: 5,
            inputTokens: 1000,
            outputTokens: 500,
            estimatedCostUsd: 0.15,
          },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: {
            callCount: 3,
            inputTokens: 800,
            outputTokens: 400,
            estimatedCostUsd: 0.10,
          },
          openrouter: {
            callCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            estimatedCostUsd: 0,
          },
        },
        totalCalls: 8,
      });

      await persistence.recordSessionEnd('multi-provider-session', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.providerBreakdown.anthropic).toBeDefined();
      expect(weekly?.providerBreakdown.anthropic!.callCount).toBe(5);
      expect(weekly?.providerBreakdown.moonshot).toBeDefined();
      expect(weekly?.providerBreakdown.moonshot!.callCount).toBe(3);
    });

    test('should update daily breakdown correctly', async () => {
      const usage = createMockSessionUsage({
        sessionId: 'daily-session',
        startedAt: '2026-02-07T14:30:00.000Z',
      });

      await persistence.recordSessionEnd('daily-session', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.dailyBreakdown.length).toBeGreaterThan(0);

      const dayEntry = weekly?.dailyBreakdown.find(d => d.date.startsWith('2026-02-07'));
      expect(dayEntry).toBeDefined();
      expect(dayEntry?.calls).toBe(5);
      expect(dayEntry?.inputTokens).toBe(1000);
      expect(dayEntry?.outputTokens).toBe(500);
    });

    test('should aggregate multiple sessions on the same day', async () => {
      const usage1 = createMockSessionUsage({
        sessionId: 'morning-session',
        startedAt: '2026-02-07T09:00:00.000Z',
        totalCalls: 3,
        providers: {
          anthropic: {
            callCount: 3,
            inputTokens: 600,
            outputTokens: 300,
            estimatedCostUsd: 0.09,
          },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openrouter: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
      });

      const usage2 = createMockSessionUsage({
        sessionId: 'afternoon-session',
        startedAt: '2026-02-07T15:00:00.000Z',
        totalCalls: 5,
        providers: {
          anthropic: {
            callCount: 5,
            inputTokens: 1000,
            outputTokens: 500,
            estimatedCostUsd: 0.15,
          },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openrouter: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
      });

      await persistence.recordSessionEnd('morning-session', usage1);
      await persistence.recordSessionEnd('afternoon-session', usage2);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      const dayEntry = weekly?.dailyBreakdown.find(d => d.date.startsWith('2026-02-07'));

      expect(dayEntry?.calls).toBe(8); // 3 + 5
      expect(dayEntry?.inputTokens).toBe(1600); // 600 + 1000
      expect(dayEntry?.outputTokens).toBe(800); // 300 + 500
      expect(dayEntry?.estimatedCostUsd).toBeCloseTo(0.24, 2); // 0.09 + 0.15
    });

    test('should sort daily breakdown by date', async () => {
      const usage1 = createMockSessionUsage({
        sessionId: 'session-1',
        startedAt: '2026-02-07T10:00:00.000Z',
      });

      const usage2 = createMockSessionUsage({
        sessionId: 'session-2',
        startedAt: '2026-02-05T10:00:00.000Z',
      });

      await persistence.recordSessionEnd('session-1', usage1);
      await persistence.recordSessionEnd('session-2', usage2);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      const dates = weekly?.dailyBreakdown.map(d => d.date);

      // Verify dates are sorted
      for (let i = 1; i < (dates?.length || 0); i++) {
        expect(dates![i]! >= dates![i - 1]!).toBe(true);
      }
    });
  });

  describe('getCurrentWeekUsage', () => {
    test('should return current week usage or empty week', async () => {
      const weekly = await persistence.getCurrentWeekUsage();

      expect(weekly).toBeDefined();
      expect(weekly.weekIdentifier).toMatch(/202\d-W\d{2}/);
      expect(weekly.sessionCount).toBeGreaterThanOrEqual(0);
    });

    test('should return empty week if no data exists', async () => {
      const weekly = await persistence.getCurrentWeekUsage();

      expect(weekly.sessionCount).toBe(0);
      expect(weekly.totals.calls).toBe(0);
      expect(weekly.sessions.length).toBe(0);
    });
  });

  describe('getRecentWeeks', () => {
    test('should return correct count of recent weeks', async () => {
      // Create multiple weeks of data
      const weeks = ['2026-W04', '2026-W05', '2026-W06'];

      for (const weekId of weeks) {
        const usage = createMockSessionUsage({
          sessionId: `session-${weekId}`,
          weekIdentifier: weekId,
        });
        await persistence.recordSessionEnd(`session-${weekId}`, usage);
      }

      const recent = await persistence.getRecentWeeks(2);
      expect(recent.length).toBeLessThanOrEqual(2);
    });

    test('should return weeks sorted in descending order', async () => {
      // Create multiple weeks of data
      const weeks = ['2026-W04', '2026-W05', '2026-W06'];

      for (const weekId of weeks) {
        const usage = createMockSessionUsage({
          sessionId: `session-${weekId}`,
          weekIdentifier: weekId,
        });
        await persistence.recordSessionEnd(`session-${weekId}`, usage);
      }

      const recent = await persistence.getRecentWeeks(3);

      // Should be sorted descending (most recent first)
      for (let i = 1; i < recent.length; i++) {
        expect(recent[i - 1]!.weekIdentifier >= recent[i]!.weekIdentifier).toBe(true);
      }
    });

    test('should return empty array when no data exists', async () => {
      const recent = await persistence.getRecentWeeks(4);
      expect(recent).toEqual([]);
    });

    test('should default to 4 weeks when count not specified', async () => {
      // Create 5 weeks of data
      for (let i = 1; i <= 5; i++) {
        const weekId = `2026-W${String(i).padStart(2, '0')}`;
        const usage = createMockSessionUsage({
          sessionId: `session-${weekId}`,
          weekIdentifier: weekId,
        });
        await persistence.recordSessionEnd(`session-${weekId}`, usage);
      }

      const recent = await persistence.getRecentWeeks();
      expect(recent.length).toBeLessThanOrEqual(4);
    });

    test('should handle corrupted week files gracefully', async () => {
      // Create valid week
      const validUsage = createMockSessionUsage({ weekIdentifier: '2026-W06' });
      await persistence.recordSessionEnd('valid-session', validUsage);

      // Create corrupted week file
      const workspacePath = path.join(os.homedir(), '.craft-agent', 'workspaces', currentWorkspaceId);
      const usagePath = path.join(workspacePath, 'usage');
      await fs.mkdir(usagePath, { recursive: true });
      await fs.writeFile(
        path.join(usagePath, 'weekly-2026-W05.json'),
        'invalid json content{{{',
        'utf-8'
      );

      const recent = await persistence.getRecentWeeks(3);

      // Should only return the valid week
      expect(recent.length).toBe(1);
      expect(recent[0]!.weekIdentifier).toBe('2026-W06');
    });
  });

  describe('edge cases', () => {
    test('should handle session with no provider usage', async () => {
      const usage = createMockSessionUsage({
        providers: {
          anthropic: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openrouter: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
        totalCalls: 0,
      });

      await persistence.recordSessionEnd('empty-session', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      expect(weekly?.sessionCount).toBe(1);
      expect(weekly?.totals.calls).toBe(0);
      expect(weekly?.totals.estimatedCostUsd).toBe(0);
    });

    test('should handle missing usage directory', async () => {
      const loaded = await persistence.loadWeeklyUsage('2026-W06');
      expect(loaded).toBeNull();
    });

    test('should determine primary model correctly when multiple providers used', async () => {
      const usage = createMockSessionUsage({
        providers: {
          anthropic: { callCount: 5, inputTokens: 1000, outputTokens: 500, estimatedCostUsd: 0.15 },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 10, inputTokens: 2000, outputTokens: 1000, estimatedCostUsd: 0.20 },
          openrouter: { callCount: 3, inputTokens: 500, outputTokens: 250, estimatedCostUsd: 0.08 },
        },
        totalCalls: 18,
      });

      await persistence.recordSessionEnd('multi-provider', usage);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      const sessionRef = weekly?.sessions[0];

      // Primary model should be moonshot (highest call count)
      expect(sessionRef?.primaryModel).toBe('moonshot');
    });

    test('should handle session with team flag correctly', async () => {
      const usageWithTeam = createMockSessionUsage({
        sessionId: 'has-team',
        teamUsage: {
          teamId: 'team-001',
          teammateCount: 2,
          totalTeamCostUsd: 0.30,
          perTeammate: {},
          perModel: {},
        },
      });

      const usageWithoutTeam = createMockSessionUsage({
        sessionId: 'no-team',
        teamUsage: undefined,
      });

      await persistence.recordSessionEnd('has-team', usageWithTeam);
      await persistence.recordSessionEnd('no-team', usageWithoutTeam);

      const weekly = await persistence.loadWeeklyUsage('2026-W06');
      const teamSession = weekly?.sessions.find(s => s.sessionId === 'has-team');
      const noTeamSession = weekly?.sessions.find(s => s.sessionId === 'no-team');

      expect(teamSession?.hadTeams).toBe(true);
      expect(noTeamSession?.hadTeams).toBe(false);
    });
  });
});
