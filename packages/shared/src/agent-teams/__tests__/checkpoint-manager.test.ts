import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointManager, DEFAULT_CHECKPOINT_CONFIG } from '../checkpoint-manager';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

describe('CheckpointManager', () => {
  let testDir: string;
  let manager: CheckpointManager;

  beforeEach(async () => {
    // Create a temp directory with a real git repo
    testDir = await mkdtemp(join(tmpdir(), 'checkpoint-test-'));

    // Initialize git repo
    await execAsync('git init', { cwd: testDir });
    await execAsync('git config user.email "test@example.com"', { cwd: testDir });
    await execAsync('git config user.name "Test User"', { cwd: testDir });

    // Create initial commit
    await writeFile(join(testDir, 'README.md'), '# Test\n');
    await execAsync('git add .', { cwd: testDir });
    await execAsync('git commit -m "Initial commit"', { cwd: testDir });

    manager = new CheckpointManager(testDir);
  });

  afterEach(async () => {
    manager.dispose();
    await rm(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      const mgr = new CheckpointManager(testDir);
      expect(mgr).toBeDefined();
    });

    it('should merge provided config with defaults', () => {
      const mgr = new CheckpointManager(testDir, { maxCheckpoints: 25 });
      expect(mgr).toBeDefined();
    });
  });

  describe('createCheckpoint', () => {
    it('should create a checkpoint at current HEAD', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Pre-work checkpoint',
        'pre-work',
        'worker-1',
      );

      expect(checkpoint.id).toMatch(/^ckpt-/);
      expect(checkpoint.teamId).toBe('team-1');
      expect(checkpoint.taskId).toBe('task-1');
      expect(checkpoint.label).toBe('Pre-work checkpoint');
      expect(checkpoint.type).toBe('pre-work');
      expect(checkpoint.teammateId).toBe('worker-1');
      expect(checkpoint.commitSha).toBeDefined();
      expect(checkpoint.createdAt).toBeDefined();
    });

    it('should record modified files', async () => {
      // Make some changes
      await writeFile(join(testDir, 'test.txt'), 'new content');

      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'With changes',
        'pre-review',
      );

      expect(checkpoint.filesAffected).toBeDefined();
      expect(checkpoint.filesAffected).toContain('test.txt');
    });

    it('should create git tag for commit strategy', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Tagged checkpoint',
        'post-pass',
      );

      const tagName = `${DEFAULT_CHECKPOINT_CONFIG.branchPrefix}${checkpoint.id}`;

      // Check if tag exists
      const { stdout } = await execAsync('git tag --list', { cwd: testDir });
      expect(stdout).toContain(tagName);
    });

    it('should handle no modified files', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Clean checkpoint',
        'pre-work',
      );

      expect(checkpoint.filesAffected).toBeUndefined();
    });

    it('should include staged files in filesAffected', async () => {
      // Create and stage a file
      await writeFile(join(testDir, 'staged.txt'), 'staged content');
      await execAsync('git add staged.txt', { cwd: testDir });

      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Staged changes',
        'pre-review',
      );

      expect(checkpoint.filesAffected).toContain('staged.txt');
    });
  });

  describe('getCheckpoint', () => {
    it('should retrieve a checkpoint by ID', async () => {
      const created = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Test',
        'pre-work',
      );

      const retrieved = manager.getCheckpoint(created.id);
      expect(retrieved).toEqual(created);
    });

    it('should return undefined for non-existent checkpoint', () => {
      const retrieved = manager.getCheckpoint('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getCheckpointsForTask', () => {
    it('should return checkpoints for a specific task', async () => {
      await manager.createCheckpoint('team-1', 'task-1', 'CP1', 'pre-work');
      await manager.createCheckpoint('team-1', 'task-1', 'CP2', 'pre-review');
      await manager.createCheckpoint('team-1', 'task-2', 'CP3', 'pre-work');

      const checkpoints = manager.getCheckpointsForTask('team-1', 'task-1');
      expect(checkpoints).toHaveLength(2);
      expect(checkpoints.every((cp) => cp.taskId === 'task-1')).toBe(true);
    });

    it('should sort checkpoints by creation time', async () => {
      const cp1 = await manager.createCheckpoint('team-1', 'task-1', 'First', 'pre-work');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const cp2 = await manager.createCheckpoint('team-1', 'task-1', 'Second', 'pre-review');

      const checkpoints = manager.getCheckpointsForTask('team-1', 'task-1');
      expect(checkpoints).toHaveLength(2);
      const [first, second] = checkpoints;
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(first!.createdAt).toBe(cp1.createdAt);
      expect(second!.createdAt).toBe(cp2.createdAt);
    });

    it('should return empty array for team with no checkpoints', () => {
      const checkpoints = manager.getCheckpointsForTask('team-999', 'task-999');
      expect(checkpoints).toEqual([]);
    });
  });

  describe('getLatestCheckpoint', () => {
    it('should return the most recent checkpoint', async () => {
      await manager.createCheckpoint('team-1', 'task-1', 'First', 'pre-work');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const latest = await manager.createCheckpoint('team-1', 'task-1', 'Latest', 'pre-review');

      const result = manager.getLatestCheckpoint('team-1', 'task-1');
      expect(result?.id).toBe(latest.id);
    });

    it('should filter by checkpoint type', async () => {
      await manager.createCheckpoint('team-1', 'task-1', 'Pre-work', 'pre-work');
      await new Promise((resolve) => setTimeout(resolve, 10));
      const preReview = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Pre-review',
        'pre-review',
      );

      const result = manager.getLatestCheckpoint('team-1', 'task-1', 'pre-review');
      expect(result?.id).toBe(preReview.id);
      expect(result?.type).toBe('pre-review');
    });

    it('should return undefined when no checkpoints exist', () => {
      const result = manager.getLatestCheckpoint('team-999', 'task-999');
      expect(result).toBeUndefined();
    });
  });

  describe('rollback', () => {
    it('should restore files changed since checkpoint', async () => {
      // Create checkpoint
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Before changes',
        'pre-work',
      );

      // Make changes
      await writeFile(join(testDir, 'test.txt'), 'modified content');

      // Rollback
      const result = await manager.rollback(checkpoint.id);

      expect(result.success).toBe(true);
      expect(result.filesRestored).toContain('test.txt');
      expect(result.error).toBeUndefined();
    });

    it('should return success with no files when nothing changed', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'No changes',
        'pre-work',
      );

      const result = await manager.rollback(checkpoint.id);

      expect(result.success).toBe(true);
      expect(result.filesRestored).toEqual([]);
    });

    it('should return error for non-existent checkpoint', async () => {
      const result = await manager.rollback('non-existent');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Checkpoint not found');
    });

    it('should restore multiple files', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Multiple files',
        'pre-work',
      );

      // Modify multiple files
      await writeFile(join(testDir, 'file1.txt'), 'content 1');
      await writeFile(join(testDir, 'file2.txt'), 'content 2');

      const result = await manager.rollback(checkpoint.id);

      expect(result.success).toBe(true);
      expect(result.filesRestored).toContain('file1.txt');
      expect(result.filesRestored).toContain('file2.txt');
    });
  });

  describe('rollbackFiles', () => {
    it('should rollback specific files only', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Selective rollback',
        'pre-work',
      );

      // Modify multiple files
      await writeFile(join(testDir, 'keep.txt'), 'keep this');
      await writeFile(join(testDir, 'rollback.txt'), 'rollback this');

      const result = await manager.rollbackFiles(checkpoint.id, ['rollback.txt']);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error for non-existent checkpoint', async () => {
      const result = await manager.rollbackFiles('non-existent', ['file.txt']);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Checkpoint not found');
    });

    it('should handle empty file list', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Empty list',
        'pre-work',
      );

      const result = await manager.rollbackFiles(checkpoint.id, []);

      expect(result.success).toBe(true);
    });
  });

  describe('cleanup', () => {
    it('should remove old checkpoints beyond max limit', async () => {
      const mgr = new CheckpointManager(testDir, { maxCheckpoints: 3 });

      // Create 5 checkpoints
      for (let i = 0; i < 5; i++) {
        await mgr.createCheckpoint('team-1', `task-${i}`, `CP ${i}`, 'pre-work');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const removed = await mgr.cleanup('team-1');

      expect(removed).toBe(2); // 5 - 3 = 2 removed
      expect(mgr.getCheckpointsForTask('team-1', 'task-0')).toHaveLength(0);
      expect(mgr.getCheckpointsForTask('team-1', 'task-4')).toHaveLength(1);

      mgr.dispose();
    });

    it('should delete git tags for removed checkpoints', async () => {
      const mgr = new CheckpointManager(testDir, { maxCheckpoints: 2 });

      // Create 3 checkpoints
      const cp1 = await mgr.createCheckpoint('team-1', 'task-1', 'CP1', 'pre-work');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mgr.createCheckpoint('team-1', 'task-2', 'CP2', 'pre-work');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await mgr.createCheckpoint('team-1', 'task-3', 'CP3', 'pre-work');

      await mgr.cleanup('team-1');

      // Tag for oldest checkpoint should be deleted
      const tagName = `${DEFAULT_CHECKPOINT_CONFIG.branchPrefix}${cp1.id}`;
      const { stdout } = await execAsync('git tag --list', { cwd: testDir });
      expect(stdout).not.toContain(tagName);

      mgr.dispose();
    });

    it('should return 0 when no cleanup needed', async () => {
      await manager.createCheckpoint('team-1', 'task-1', 'CP1', 'pre-work');

      const removed = await manager.cleanup('team-1');

      expect(removed).toBe(0);
    });

    it('should return 0 for non-existent team', async () => {
      const removed = await manager.cleanup('team-999');
      expect(removed).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should clear all in-memory state', async () => {
      const checkpoint = await manager.createCheckpoint(
        'team-1',
        'task-1',
        'Test',
        'pre-work',
      );

      manager.dispose();

      const retrieved = manager.getCheckpoint(checkpoint.id);
      expect(retrieved).toBeUndefined();

      const checkpoints = manager.getCheckpointsForTask('team-1', 'task-1');
      expect(checkpoints).toEqual([]);
    });
  });
});
