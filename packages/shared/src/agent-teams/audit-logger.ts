/**
 * Audit Logger
 *
 * Records every quality gate run, review cycle, and major team event to a JSONL file
 * for debugging and replay. This provides a complete audit trail of what happened
 * during a team's execution, including quality reviews, feedback loops, and escalations.
 *
 * The audit log is append-only and stored as JSONL (JSON Lines) for easy streaming
 * and incremental parsing.
 */

import { appendFile, mkdir, readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { existsSync } from 'fs';

// ============================================================
// Types
// ============================================================

/**
 * Audit log entry types
 */
export type AuditEntryType =
  | 'quality-gate-started'
  | 'quality-gate-completed'
  | 'feedback-sent'
  | 'review-cycle-started'
  | 'review-cycle-completed'
  | 'escalation-triggered'
  | 'escalation-completed'
  | 'checkpoint-created'
  | 'checkpoint-rollback'
  | 'stall-detected'
  | 'file-conflict-detected'
  | 'integration-check-started'
  | 'integration-check-completed'
  | 'task-status-change'
  | 'teammate-health-change';

export interface AuditEntry {
  timestamp: string;
  type: AuditEntryType;
  teamId: string;
  taskId?: string;
  teammateId?: string;
  cycleNumber?: number;
  data: Record<string, unknown>;
}

export interface AuditSummary {
  totalReviews: number;
  passedFirstCycle: number;
  averageCycles: number;
  escalationCount: number;
  totalStalls: number;
  totalConflicts: number;
}

/**
 * Filter criteria for querying audit entries
 */
export interface AuditFilter {
  type?: AuditEntryType;
  taskId?: string;
  teammateId?: string;
}

// ============================================================
// Audit Logger Class
// ============================================================

/**
 * Audit Logger — records team events to a JSONL file
 */
export class AuditLogger {
  private teamId: string;
  private logPath: string;

  /**
   * Initialize with team ID and base directory
   * @param teamId - Team identifier
   * @param baseDir - Base directory for team data (typically ~/.craft-agent/workspaces/{id}/teams/)
   */
  constructor(teamId: string, baseDir: string) {
    this.teamId = teamId;
    this.logPath = join(baseDir, teamId, 'audit.jsonl');
  }

  /**
   * Append a JSONL entry to the audit log file
   */
  async log(entry: Omit<AuditEntry, 'timestamp' | 'teamId'>): Promise<void> {
    const fullEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      teamId: this.teamId,
      ...entry,
    };

    await this.ensureLogFile();

    const line = JSON.stringify(fullEntry) + '\n';
    await appendFile(this.logPath, line, 'utf-8');
  }

  /**
   * Read and filter audit entries
   */
  async getEntries(filter?: AuditFilter): Promise<AuditEntry[]> {
    if (!existsSync(this.logPath)) {
      return [];
    }

    const content = await readFile(this.logPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const entries: AuditEntry[] = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        if (this.matchesFilter(entry, filter)) {
          entries.push(entry);
        }
      } catch {
        // Skip malformed lines
        continue;
      }
    }

    return entries;
  }

  /**
   * Get all entries for a specific task, sorted by timestamp
   */
  async getTaskTimeline(taskId: string): Promise<AuditEntry[]> {
    const entries = await this.getEntries({ taskId });
    return entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /**
   * Get aggregate stats (total reviews, pass rate, avg cycles, total cost)
   */
  async getSummary(): Promise<AuditSummary> {
    const entries = await this.getEntries();

    let totalReviews = 0;
    let passedFirstCycle = 0;
    let totalCycles = 0;
    let escalationCount = 0;
    let totalStalls = 0;
    let totalConflicts = 0;

    // Track unique review sessions (by taskId + teammateId)
    const reviewSessions = new Map<string, { cycleCount: number; passed: boolean }>();

    for (const entry of entries) {
      switch (entry.type) {
        case 'quality-gate-completed': {
          const sessionKey = `${entry.taskId}-${entry.teammateId}`;
          const session = reviewSessions.get(sessionKey) || { cycleCount: 0, passed: false };

          session.cycleCount = entry.cycleNumber || 1;
          session.passed = entry.data.passed === true;
          reviewSessions.set(sessionKey, session);

          if (session.passed) {
            totalReviews++;
            totalCycles += session.cycleCount;
            if (session.cycleCount === 1) {
              passedFirstCycle++;
            }
          }
          break;
        }
        case 'escalation-triggered':
          escalationCount++;
          break;
        case 'stall-detected':
          totalStalls++;
          break;
        case 'file-conflict-detected':
          totalConflicts++;
          break;
      }
    }

    const averageCycles = totalReviews > 0 ? totalCycles / totalReviews : 0;

    return {
      totalReviews,
      passedFirstCycle,
      averageCycles: Math.round(averageCycles * 100) / 100, // Round to 2 decimal places
      escalationCount,
      totalStalls,
      totalConflicts,
    };
  }

  // ============================================================
  // Private Helpers
  // ============================================================

  /**
   * Ensure the log file directory exists
   */
  private async ensureLogFile(): Promise<void> {
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  /**
   * Check if an entry matches the filter criteria
   */
  private matchesFilter(entry: AuditEntry, filter?: AuditFilter): boolean {
    if (!filter) return true;

    if (filter.type && entry.type !== filter.type) {
      return false;
    }

    if (filter.taskId && entry.taskId !== filter.taskId) {
      return false;
    }

    if (filter.teammateId && entry.teammateId !== filter.teammateId) {
      return false;
    }

    return true;
  }
}
