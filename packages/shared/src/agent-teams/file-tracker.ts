/**
 * File Ownership Tracker
 *
 * Tracks which files each teammate is modifying and detects conflicts
 * when multiple teammates attempt to modify the same file. Supports
 * two modes: 'warn' (log + emit) and 'strict' (block + emit).
 *
 * This module uses only Node.js built-ins (EventEmitter, path).
 */

import { EventEmitter } from 'events';
import { resolve } from 'path';

// ============================================================
// Configuration
// ============================================================

export type ConflictMode = 'warn' | 'strict';

export interface FileTrackerConfig {
  /** How to handle conflicts. 'warn' = log + emit event, 'strict' = block + emit. Default: 'warn' */
  mode: ConflictMode;
}

const DEFAULT_FILE_TRACKER_CONFIG: FileTrackerConfig = {
  mode: 'warn',
};

// ============================================================
// Types
// ============================================================

export interface FileOwnership {
  /** Absolute file path */
  filePath: string;
  /** ID of the teammate who owns this file */
  ownerId: string;
  /** Name of the owning teammate */
  ownerName: string;
  /** Task the teammate was working on when they first modified this file */
  taskId?: string;
  /** When ownership was established */
  since: string;
  /** Number of modifications by the owner */
  modificationCount: number;
}

export interface FileConflict {
  /** The contested file path */
  filePath: string;
  /** The current owner */
  currentOwner: FileOwnership;
  /** The teammate attempting to modify */
  attemptedBy: { teammateId: string; teammateName: string; taskId?: string };
  /** When the conflict was detected */
  detectedAt: string;
  /** Whether the modification was blocked (only in strict mode) */
  blocked: boolean;
}

// ============================================================
// FileOwnershipTracker
// ============================================================

export class FileOwnershipTracker extends EventEmitter {
  private readonly config: FileTrackerConfig;

  /** teamId -> normalizedFilePath -> ownership */
  private readonly ownership: Map<string, Map<string, FileOwnership>> = new Map();

  /** teamId -> accumulated conflicts */
  private readonly conflicts: Map<string, FileConflict[]> = new Map();

  constructor(config?: Partial<FileTrackerConfig>) {
    super();
    this.config = { ...DEFAULT_FILE_TRACKER_CONFIG, ...config };
  }

  // ============================================================
  // File Modification Tracking
  // ============================================================

  /**
   * Record that a teammate modified a file.
   * Called when a Write, Edit, or MultiEdit tool is used.
   *
   * @returns A FileConflict if ownership was contested, or null if no conflict.
   */
  recordModification(
    teamId: string,
    teammateId: string,
    teammateName: string,
    filePath: string,
    taskId?: string,
  ): FileConflict | null {
    const normalized = this.normalizePath(filePath);
    const teamMap = this.ensureTeamMap(teamId);
    const existing = teamMap.get(normalized);

    // No current owner — establish ownership
    if (!existing) {
      const ownership: FileOwnership = {
        filePath: normalized,
        ownerId: teammateId,
        ownerName: teammateName,
        taskId,
        since: new Date().toISOString(),
        modificationCount: 1,
      };

      teamMap.set(normalized, ownership);
      this.emit('file:ownership-established', ownership);
      return null;
    }

    // Same teammate — increment count
    if (existing.ownerId === teammateId) {
      existing.modificationCount++;
      return null;
    }

    // Different teammate — conflict
    const conflict: FileConflict = {
      filePath: normalized,
      currentOwner: { ...existing },
      attemptedBy: { teammateId, teammateName, taskId },
      detectedAt: new Date().toISOString(),
      blocked: this.config.mode === 'strict',
    };

    // Store the conflict (implements M1: cap at 50 per team to prevent unbounded growth)
    if (!this.conflicts.has(teamId)) {
      this.conflicts.set(teamId, []);
    }
    const conflictList = this.conflicts.get(teamId)!;
    conflictList.push(conflict);
    if (conflictList.length > 50) {
      conflictList.splice(0, conflictList.length - 50);
    }

    this.emit('file:conflict', conflict);
    return conflict;
  }

  // ============================================================
  // Ownership Release
  // ============================================================

  /**
   * Release ownership of specific files.
   * Called when a task passes quality gates and work is accepted.
   */
  releaseOwnership(teamId: string, filePaths: string[]): void {
    const teamMap = this.ownership.get(teamId);
    if (!teamMap) return;

    for (const filePath of filePaths) {
      const normalized = this.normalizePath(filePath);
      const existing = teamMap.get(normalized);

      if (existing) {
        teamMap.delete(normalized);
        this.emit('file:ownership-released', {
          teamId,
          filePath: normalized,
          previousOwner: existing.ownerId,
        });
      }
    }
  }

  /**
   * Release all files owned by a teammate.
   * Called when a teammate shuts down.
   */
  releaseTeammateFiles(teamId: string, teammateId: string): void {
    const teamMap = this.ownership.get(teamId);
    if (!teamMap) return;

    for (const [normalized, ownership] of teamMap.entries()) {
      if (ownership.ownerId === teammateId) {
        teamMap.delete(normalized);
        this.emit('file:ownership-released', {
          teamId,
          filePath: normalized,
          previousOwner: teammateId,
        });
      }
    }
  }

  // ============================================================
  // Queries
  // ============================================================

  /**
   * Check who owns a specific file.
   */
  getOwnership(teamId: string, filePath: string): FileOwnership | null {
    const normalized = this.normalizePath(filePath);
    return this.ownership.get(teamId)?.get(normalized) ?? null;
  }

  /**
   * Get all files owned by a specific teammate.
   */
  getTeammateFiles(teamId: string, teammateId: string): FileOwnership[] {
    const teamMap = this.ownership.get(teamId);
    if (!teamMap) return [];

    const result: FileOwnership[] = [];
    for (const ownership of teamMap.values()) {
      if (ownership.ownerId === teammateId) {
        result.push(ownership);
      }
    }
    return result;
  }

  /**
   * Get all recorded conflicts for a team.
   */
  getConflicts(teamId: string): FileConflict[] {
    return this.conflicts.get(teamId) ?? [];
  }

  /**
   * Get the full file-to-owner map for a team.
   */
  getTeamFileMap(teamId: string): Map<string, FileOwnership> {
    return this.ownership.get(teamId) ?? new Map();
  }

  /**
   * Pre-check if a modification would cause a conflict WITHOUT recording it.
   * Used by PreToolUse hooks to decide whether to block a tool call.
   */
  checkConflict(
    teamId: string,
    filePath: string,
    teammateId: string,
  ): FileConflict | null {
    const normalized = this.normalizePath(filePath);
    const teamMap = this.ownership.get(teamId);
    if (!teamMap) return null;

    const existing = teamMap.get(normalized);
    if (!existing) return null;
    if (existing.ownerId === teammateId) return null;

    // Would conflict — construct a preview without recording it
    return {
      filePath: normalized,
      currentOwner: { ...existing },
      attemptedBy: { teammateId, teammateName: '' },
      detectedAt: new Date().toISOString(),
      blocked: this.config.mode === 'strict',
    };
  }

  // ============================================================
  // Cleanup
  // ============================================================

  /**
   * Dispose of the tracker: clear all internal state.
   */
  dispose(): void {
    this.ownership.clear();
    this.conflicts.clear();
    this.removeAllListeners();
  }

  // ============================================================
  // Internal Helpers
  // ============================================================

  /**
   * Normalize a file path to an absolute path with forward slashes.
   * Ensures consistent keys regardless of OS or relative paths.
   */
  private normalizePath(filePath: string): string {
    const resolved = resolve(filePath);
    return resolved.replace(/\\/g, '/');
  }

  /**
   * Ensure the team-level ownership map exists.
   */
  private ensureTeamMap(teamId: string): Map<string, FileOwnership> {
    if (!this.ownership.has(teamId)) {
      this.ownership.set(teamId, new Map());
    }
    return this.ownership.get(teamId)!;
  }
}
