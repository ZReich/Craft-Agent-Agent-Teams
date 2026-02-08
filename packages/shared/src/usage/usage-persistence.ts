/**
 * Usage Persistence Service
 *
 * Handles saving and loading usage data to/from the filesystem.
 * Stores session-level data in session folders and weekly aggregations
 * in the workspace usage directory.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type {
  SessionUsage,
  WeeklyUsageSummary,
  DailyUsage,
  SessionUsageRef,
} from '@craft-agent/core';

export class UsagePersistence {
  private workspacePath: string;

  constructor(workspaceId: string) {
    this.workspacePath = path.join(os.homedir(), '.craft-agent', 'workspaces', workspaceId);
  }

  private get usagePath(): string {
    return path.join(this.workspacePath, 'usage');
  }

  // ============================================================
  // Week Identifier Utilities
  // ============================================================

  /** Get ISO week identifier for a date (e.g., "2026-W06") */
  getWeekIdentifier(date: Date): string {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  /** Get week start (Monday) and end (Sunday) dates from week identifier */
  private getWeekDates(weekIdentifier: string): { start: string; end: string } {
    const [yearStr, weekStr] = weekIdentifier.split('-W');
    const year = parseInt(yearStr);
    const week = parseInt(weekStr);
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7;
    const monday = new Date(jan4);
    monday.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (week - 1) * 7);
    const sunday = new Date(monday);
    sunday.setUTCDate(monday.getUTCDate() + 6);
    sunday.setUTCHours(23, 59, 59, 999);
    return { start: monday.toISOString(), end: sunday.toISOString() };
  }

  // ============================================================
  // Session Usage
  // ============================================================

  /** Save session usage data to session folder */
  async saveSessionUsage(sessionId: string, usage: SessionUsage): Promise<void> {
    const sessionPath = path.join(this.workspacePath, 'sessions', sessionId);
    await fs.mkdir(sessionPath, { recursive: true });
    await fs.writeFile(
      path.join(sessionPath, 'usage.json'),
      JSON.stringify(usage, null, 2),
      'utf-8'
    );
  }

  /** Load session usage data */
  async loadSessionUsage(sessionId: string): Promise<SessionUsage | null> {
    try {
      const data = await fs.readFile(
        path.join(this.workspacePath, 'sessions', sessionId, 'usage.json'),
        'utf-8'
      );
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // ============================================================
  // Weekly Aggregation
  // ============================================================

  /** Record a completed session into weekly aggregate */
  async recordSessionEnd(sessionId: string, usage: SessionUsage): Promise<void> {
    const weekId = usage.weekIdentifier;
    const weekly = await this.loadWeeklyUsage(weekId) || this.createEmptyWeek(weekId);

    // Build session reference
    const totalTokens = Object.values(usage.providers).reduce(
      (sum, p) => sum + p.inputTokens + p.outputTokens, 0
    );
    const totalCost = Object.values(usage.providers).reduce(
      (sum, p) => sum + p.estimatedCostUsd, 0
    );

    // Determine primary model (most calls)
    let primaryModel = 'unknown';
    let maxCalls = 0;
    for (const [provider, data] of Object.entries(usage.providers)) {
      if (data.callCount > maxCalls) {
        maxCalls = data.callCount;
        primaryModel = provider;
      }
    }

    const sessionRef: SessionUsageRef = {
      sessionId,
      startedAt: usage.startedAt,
      endedAt: usage.lastUpdatedAt,
      calls: usage.totalCalls,
      tokens: totalTokens,
      estimatedCostUsd: totalCost,
      primaryModel,
      hadTeams: !!usage.teamUsage,
    };

    // Add session
    weekly.sessions.push(sessionRef);
    weekly.sessionCount = weekly.sessions.length;

    // Update totals
    weekly.totals.calls += usage.totalCalls;
    weekly.totals.durationMs += usage.totalDurationMs;
    for (const [provider, data] of Object.entries(usage.providers)) {
      weekly.totals.inputTokens += data.inputTokens;
      weekly.totals.outputTokens += data.outputTokens;
      weekly.totals.estimatedCostUsd += data.estimatedCostUsd;

      if (!weekly.providerBreakdown[provider]) {
        weekly.providerBreakdown[provider] = {
          callCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        };
      }
      weekly.providerBreakdown[provider].callCount += data.callCount;
      weekly.providerBreakdown[provider].inputTokens += data.inputTokens;
      weekly.providerBreakdown[provider].outputTokens += data.outputTokens;
      weekly.providerBreakdown[provider].estimatedCostUsd += data.estimatedCostUsd;
    }

    // Update team usage
    if (usage.teamUsage) {
      if (!weekly.teamUsage) {
        weekly.teamUsage = { teamsCreated: 0, teammatesSpawned: 0, totalTeamCostUsd: 0 };
      }
      weekly.teamUsage.teamsCreated += 1;
      weekly.teamUsage.teammatesSpawned += usage.teamUsage.teammateCount;
      weekly.teamUsage.totalTeamCostUsd += usage.teamUsage.totalTeamCostUsd;
    }

    // Update daily breakdown
    const sessionDate = new Date(usage.startedAt).toISOString().split('T')[0];
    let dayEntry = weekly.dailyBreakdown.find(d => d.date.startsWith(sessionDate));
    if (!dayEntry) {
      dayEntry = {
        date: sessionDate + 'T00:00:00.000Z',
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      };
      weekly.dailyBreakdown.push(dayEntry);
      weekly.dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));
    }
    dayEntry.calls += usage.totalCalls;
    dayEntry.inputTokens += Object.values(usage.providers).reduce((s, p) => s + p.inputTokens, 0);
    dayEntry.outputTokens += Object.values(usage.providers).reduce((s, p) => s + p.outputTokens, 0);
    dayEntry.estimatedCostUsd += totalCost;

    await this.saveWeeklyUsage(weekId, weekly);
  }

  /** Load weekly usage summary */
  async loadWeeklyUsage(weekIdentifier: string): Promise<WeeklyUsageSummary | null> {
    try {
      const data = await fs.readFile(
        path.join(this.usagePath, `weekly-${weekIdentifier}.json`),
        'utf-8'
      );
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /** Save weekly usage summary */
  private async saveWeeklyUsage(weekIdentifier: string, weekly: WeeklyUsageSummary): Promise<void> {
    await fs.mkdir(this.usagePath, { recursive: true });
    await fs.writeFile(
      path.join(this.usagePath, `weekly-${weekIdentifier}.json`),
      JSON.stringify(weekly, null, 2),
      'utf-8'
    );
  }

  /** Create an empty weekly summary */
  private createEmptyWeek(weekIdentifier: string): WeeklyUsageSummary {
    const { start, end } = this.getWeekDates(weekIdentifier);
    return {
      weekIdentifier,
      startDate: start,
      endDate: end,
      sessionCount: 0,
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, durationMs: 0 },
      providerBreakdown: {},
      dailyBreakdown: [],
      sessions: [],
    };
  }

  // ============================================================
  // Queries
  // ============================================================

  /** Get current week usage */
  async getCurrentWeekUsage(): Promise<WeeklyUsageSummary> {
    const weekId = this.getWeekIdentifier(new Date());
    return await this.loadWeeklyUsage(weekId) || this.createEmptyWeek(weekId);
  }

  /** Get recent N weeks */
  async getRecentWeeks(count: number = 4): Promise<WeeklyUsageSummary[]> {
    try {
      await fs.mkdir(this.usagePath, { recursive: true });
      const files = await fs.readdir(this.usagePath);
      const weekFiles = files
        .filter(f => f.startsWith('weekly-') && f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(0, count);

      const weeks: WeeklyUsageSummary[] = [];
      for (const file of weekFiles) {
        try {
          const data = await fs.readFile(path.join(this.usagePath, file), 'utf-8');
          weeks.push(JSON.parse(data));
        } catch { /* skip corrupted files */ }
      }
      return weeks;
    } catch {
      return [];
    }
  }
}
