/**
 * Checkpoint Manager
 *
 * Git-based checkpointing and rollback for teammate work.
 * Allows the review loop to snapshot state before reviews and rollback
 * if quality gates fail after max cycles.
 *
 * This module uses git CLI commands to create lightweight checkpoints
 * (tags or simple SHA references) and restore files to checkpoint state.
 */

import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { rm } from 'fs/promises';
import { join } from 'path';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================
// Types
// ============================================================

export interface Checkpoint {
  /** Unique checkpoint ID */
  id: string;
  /** Team this checkpoint belongs to */
  teamId: string;
  /** Task this checkpoint is associated with */
  taskId: string;
  /** Teammate who was working */
  teammateId?: string;
  /** Git commit SHA of the checkpoint */
  commitSha: string;
  /** Human-readable label */
  label: string;
  /** When the checkpoint was created */
  createdAt: string;
  /** What type of checkpoint: pre-work, pre-review, post-review-pass */
  type: 'pre-work' | 'pre-review' | 'post-pass';
  /** Files that were part of this checkpoint's changes */
  filesAffected?: string[];
}

export interface CheckpointManagerConfig {
  /** Whether to use git stash (lighter) or git commits on a checkpoint branch (safer). Default: 'commit' */
  strategy: 'stash' | 'commit';
  /** Branch prefix for checkpoint branches. Default: 'checkpoint/' */
  branchPrefix: string;
  /** Maximum checkpoints to keep per team before cleanup. Default: 50 */
  maxCheckpoints: number;
}

export interface RollbackResult {
  success: boolean;
  filesRestored: string[];
  error?: string;
}

// ============================================================
// Defaults
// ============================================================

export const DEFAULT_CHECKPOINT_CONFIG: CheckpointManagerConfig = {
  strategy: 'commit',
  branchPrefix: 'checkpoint/',
  maxCheckpoints: 50,
};

/** Timeout for git commands in milliseconds */
const GIT_TIMEOUT = 10_000;

// ============================================================
// Checkpoint Manager
// ============================================================

/**
 * Manages git-based checkpoints for teammate work.
 *
 * Checkpoints record a known-good state (HEAD commit SHA + affected files)
 * so that the review loop can rollback if quality gates fail repeatedly.
 */
export class CheckpointManager {
  private readonly workingDirectory: string;
  private readonly config: CheckpointManagerConfig;

  /** checkpointId -> Checkpoint */
  private checkpoints = new Map<string, Checkpoint>();
  /** teamId -> Checkpoint[] (ordered by creation time) */
  private teamCheckpoints = new Map<string, Checkpoint[]>();

  constructor(workingDirectory: string, config?: Partial<CheckpointManagerConfig>) {
    this.workingDirectory = workingDirectory;
    this.config = { ...DEFAULT_CHECKPOINT_CONFIG, ...config };
  }

  // ============================================================
  // Public API
  // ============================================================

  /**
   * Create a checkpoint recording the current git state.
   *
   * Records the current HEAD SHA and any modified files so that
   * we can later restore files to this state if needed.
   */
  async createCheckpoint(
    teamId: string,
    taskId: string,
    label: string,
    type: Checkpoint['type'],
    teammateId?: string,
  ): Promise<Checkpoint> {
    // Get current HEAD SHA
    const headResult = await this.execGit('rev-parse HEAD');
    if (!headResult.success) {
      throw new Error(`Failed to get HEAD SHA: ${headResult.error}`);
    }
    const commitSha = headResult.stdout.trim();

    // Get modified files (staged + unstaged relative to HEAD)
    const filesResult = await this.execGit('diff --name-only HEAD');
    const cachedResult = await this.execGit('diff --cached --name-only');

    const filesSet = new Set<string>();
    if (filesResult.success) {
      for (const f of filesResult.stdout.trim().split('\n')) {
        if (f) filesSet.add(f);
      }
    }
    if (cachedResult.success) {
      for (const f of cachedResult.stdout.trim().split('\n')) {
        if (f) filesSet.add(f);
      }
    }
    const untrackedResult = await this.execGit('ls-files --others --exclude-standard');
    if (untrackedResult.success) {
      for (const f of untrackedResult.stdout.trim().split('\n')) {
        if (f) filesSet.add(f);
      }
    }

    const filesAffected = filesSet.size > 0 ? [...filesSet] : undefined;

    // Generate checkpoint ID
    const id = `ckpt-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // For commit strategy, create a lightweight tag to prevent GC
    if (this.config.strategy === 'commit') {
      const tagName = `${this.config.branchPrefix}${id}`;
      const tagResult = await this.execGit(`tag ${tagName} ${commitSha}`);
      if (!tagResult.success) {
        // Non-fatal: checkpoint still works via SHA, just won't survive GC
      }
    }

    const checkpoint: Checkpoint = {
      id,
      teamId,
      taskId,
      teammateId,
      commitSha,
      label,
      createdAt: new Date().toISOString(),
      type,
      filesAffected,
    };

    // Store in memory
    this.checkpoints.set(id, checkpoint);

    const teamList = this.teamCheckpoints.get(teamId) ?? [];
    teamList.push(checkpoint);
    this.teamCheckpoints.set(teamId, teamList);

    return checkpoint;
  }

  /**
   * Rollback all files changed since a checkpoint to their state at checkpoint time.
   *
   * Uses `git checkout <sha> -- <files>` to restore files to the checkpoint state.
   * Only restores files that have actually changed since the checkpoint.
   */
  async rollback(checkpointId: string): Promise<RollbackResult> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { success: false, filesRestored: [], error: `Checkpoint not found: ${checkpointId}` };
    }

    // Get files that changed since the checkpoint
    const diffResult = await this.execGit(`diff --name-only ${checkpoint.commitSha} HEAD`);
    if (!diffResult.success) {
      return { success: false, filesRestored: [], error: `Failed to diff against checkpoint: ${diffResult.error}` };
    }

    const files = diffResult.stdout
      .trim()
      .split('\n')
      .filter(Boolean);
    const untrackedResult = await this.execGit('ls-files --others --exclude-standard');
    if (untrackedResult.success) {
      for (const f of untrackedResult.stdout.trim().split('\n').filter(Boolean)) {
        files.push(f);
      }
    }
    const uniqueFiles = [...new Set(files)];

    if (uniqueFiles.length === 0) {
      return { success: true, filesRestored: [] };
    }

    // Restore files to checkpoint state
    const restoreResult = await this.restoreFiles(checkpoint.commitSha, uniqueFiles);
    return restoreResult;
  }

  /**
   * Selectively rollback specific files to their state at checkpoint time.
   */
  async rollbackFiles(
    checkpointId: string,
    files: string[],
  ): Promise<{ success: boolean; error?: string }> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      return { success: false, error: `Checkpoint not found: ${checkpointId}` };
    }

    if (files.length === 0) {
      return { success: true };
    }

    const result = await this.restoreFiles(checkpoint.commitSha, files);
    return { success: result.success, error: result.error };
  }

  /** Get checkpoint metadata by ID */
  getCheckpoint(checkpointId: string): Checkpoint | undefined {
    return this.checkpoints.get(checkpointId);
  }

  /** Get all checkpoints for a task, sorted by creation time (oldest first) */
  getCheckpointsForTask(teamId: string, taskId: string): Checkpoint[] {
    const teamList = this.teamCheckpoints.get(teamId) ?? [];
    return teamList
      .filter((c) => c.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Get the most recent checkpoint for a task, optionally filtered by type.
   */
  getLatestCheckpoint(
    teamId: string,
    taskId: string,
    type?: Checkpoint['type'],
  ): Checkpoint | undefined {
    const checkpoints = this.getCheckpointsForTask(teamId, taskId);
    if (type) {
      const filtered = checkpoints.filter((c) => c.type === type);
      return filtered[filtered.length - 1];
    }
    return checkpoints[checkpoints.length - 1];
  }

  /**
   * Remove old checkpoints beyond `maxCheckpoints` for a team.
   * Deletes associated git tags for the commit strategy.
   * Returns the number of checkpoints removed.
   */
  async cleanup(teamId: string): Promise<number> {
    const teamList = this.teamCheckpoints.get(teamId);
    if (!teamList || teamList.length <= this.config.maxCheckpoints) {
      return 0;
    }

    // Remove oldest checkpoints first
    const toRemove = teamList.length - this.config.maxCheckpoints;
    const removed = teamList.splice(0, toRemove);

    for (const checkpoint of removed) {
      this.checkpoints.delete(checkpoint.id);

      // Delete associated git tag if using commit strategy
      if (this.config.strategy === 'commit') {
        const tagName = `${this.config.branchPrefix}${checkpoint.id}`;
        await this.execGit(`tag -d ${tagName}`);
        // Ignore failures — tag may already be gone
      }
    }

    return removed.length;
  }

  /** Clear all in-memory state */
  dispose(): void {
    this.checkpoints.clear();
    this.teamCheckpoints.clear();
  }

  // ============================================================
  // Internal Helpers
  // ============================================================

  /**
   * Restore files to a specific commit state using git checkout.
   * Handles errors per-file to report which files conflicted.
   */
  private async restoreFiles(commitSha: string, files: string[]): Promise<RollbackResult> {
    const restored: string[] = [];
    const conflicts: string[] = [];

    for (const file of files) {
      try {
        const existsAtCommit = await this.fileExistsAtCommit(commitSha, file);
        if (existsAtCommit) {
          const fileResult = await this.execGit(`checkout ${commitSha} -- "${file}"`);
          if (fileResult.success) {
            restored.push(file);
          } else {
            conflicts.push(file);
          }
          continue;
        }

        await rm(join(this.workingDirectory, file), { force: true, recursive: true });
        restored.push(file);
      } catch {
        conflicts.push(file);
      }
    }

    if (conflicts.length > 0) {
      return {
        success: false,
        filesRestored: restored,
        error: `Failed to restore ${conflicts.length} file(s): ${conflicts.join(', ')}`,
      };
    }

    return { success: true, filesRestored: restored };
  }

  private async fileExistsAtCommit(commitSha: string, filePath: string): Promise<boolean> {
    const escapedPath = filePath.replace(/"/g, '\\"');
    const result = await this.execGit(`ls-tree -r --name-only ${commitSha} -- "${escapedPath}"`);
    if (!result.success) return false;
    return result.stdout
      .trim()
      .split('\n')
      .some((line) => line.trim() === filePath);
  }

  /**
   * Execute a git command in the working directory with timeout.
   * Returns a result object instead of throwing on failure.
   */
  private async execGit(
    args: string,
  ): Promise<{ success: boolean; stdout: string; error?: string }> {
    try {
      const { stdout, stderr } = await execAsync(`git ${args}`, {
        cwd: this.workingDirectory,
        timeout: GIT_TIMEOUT,
      });
      return { success: true, stdout, error: stderr || undefined };
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);

      // Check for "not a git repository" specifically
      if (message.includes('not a git repository')) {
        return { success: false, stdout: '', error: 'Not a git repository' };
      }

      return { success: false, stdout: '', error: message };
    }
  }
}
