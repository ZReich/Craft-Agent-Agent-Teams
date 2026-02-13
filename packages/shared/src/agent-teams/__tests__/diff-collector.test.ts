import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DiffCollector } from '../diff-collector';
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

describe('DiffCollector', () => {
  let testDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    testDir = await mkdtemp(join(tmpdir(), 'diff-collector-test-'));

    // Initialize a git repo
    execSync('git init', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
  });

  afterEach(async () => {
    // Clean up the test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('collectWorkingDiff', () => {
    it('should return empty diff when there are no changes', async () => {
      // Create an initial commit
      await writeFile(join(testDir, 'README.md'), '# Test\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      const result = await DiffCollector.collectWorkingDiff(testDir);

      expect(result.filesAdded).toEqual([]);
      expect(result.filesChanged).toEqual([]);
      expect(result.filesDeleted).toEqual([]);
      expect(result.unifiedDiff).toBe('');
      expect(result.stats.filesChanged).toBe(0);
    });

    it('should detect added files', async () => {
      // Create initial commit
      await writeFile(join(testDir, 'README.md'), '# Test\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Add a new file
      await writeFile(join(testDir, 'new-file.txt'), 'New content\n');

      const result = await DiffCollector.collectWorkingDiff(testDir);

      expect(result.filesAdded).toContain('new-file.txt');
      expect(result.unifiedDiff).toContain('new-file.txt');
      expect(result.stats.filesChanged).toBeGreaterThan(0);
    });

    it('should detect modified files', async () => {
      // Create initial commit
      await writeFile(join(testDir, 'README.md'), '# Test\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Modify the file
      await writeFile(join(testDir, 'README.md'), '# Test\n\nModified content\n');

      const result = await DiffCollector.collectWorkingDiff(testDir);

      expect(result.filesChanged).toContain('README.md');
      expect(result.unifiedDiff).toContain('Modified content');
    });

    it('should detect deleted files', async () => {
      // Create initial commit
      await writeFile(join(testDir, 'README.md'), '# Test\n');
      await writeFile(join(testDir, 'to-delete.txt'), 'Delete me\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Delete the file
      await rm(join(testDir, 'to-delete.txt'));

      const result = await DiffCollector.collectWorkingDiff(testDir);

      expect(result.filesDeleted).toContain('to-delete.txt');
    });
  });

  describe('collectStagedDiff', () => {
    it('should only return staged changes', async () => {
      // Create initial commit
      await writeFile(join(testDir, 'README.md'), '# Test\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Add a staged file
      await writeFile(join(testDir, 'staged.txt'), 'Staged\n');
      execSync('git add staged.txt', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Add an unstaged file
      await writeFile(join(testDir, 'unstaged.txt'), 'Unstaged\n');

      const result = await DiffCollector.collectStagedDiff(testDir);

      expect(result.filesAdded).toContain('staged.txt');
      expect(result.filesAdded).not.toContain('unstaged.txt');
    });
  });

  describe('collectDiffForFiles', () => {
    it('should return empty diff for empty file list', async () => {
      const result = await DiffCollector.collectDiffForFiles(testDir, []);

      expect(result.filesAdded).toEqual([]);
      expect(result.unifiedDiff).toBe('');
    });

    it('should return diff for specific files only', async () => {
      // Create initial commit
      await writeFile(join(testDir, 'file1.txt'), 'Content 1\n');
      await writeFile(join(testDir, 'file2.txt'), 'Content 2\n');
      execSync('git add .', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });
      execSync('git commit -m "Initial commit"', { cwd: testDir, encoding: 'utf-8', stdio: 'pipe' });

      // Modify both files
      await writeFile(join(testDir, 'file1.txt'), 'Modified 1\n');
      await writeFile(join(testDir, 'file2.txt'), 'Modified 2\n');

      const result = await DiffCollector.collectDiffForFiles(testDir, ['file1.txt']);

      expect(result.unifiedDiff).toContain('file1.txt');
      expect(result.unifiedDiff).not.toContain('file2.txt');
    });
  });

  describe('error handling', () => {
    it('should handle non-git directories gracefully', async () => {
      const nonGitDir = await mkdtemp(join(tmpdir(), 'non-git-'));

      const result = await DiffCollector.collectWorkingDiff(nonGitDir);

      expect(result.filesAdded).toEqual([]);
      expect(result.unifiedDiff).toBe('');

      await rm(nonGitDir, { recursive: true, force: true });
    });
  });
});
