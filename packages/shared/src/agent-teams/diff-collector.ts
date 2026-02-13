/**
 * Diff Collector
 *
 * Collects git diffs of a teammate's work for quality gate review.
 * Parses and structures git output into a format suitable for LLM review.
 *
 * This module uses git CLI commands to extract diffs in various contexts:
 * - Since a specific commit (checkpoint-based review)
 * - Staged changes only (pre-commit review)
 * - Working tree changes (all uncommitted work)
 * - Specific files only (targeted review)
 */

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// ============================================================
// Types
// ============================================================

/**
 * Structured diff for quality gate review
 */
export interface ReviewDiff {
  /** Files that were modified */
  filesChanged: string[];
  /** Files that were added */
  filesAdded: string[];
  /** Files that were deleted */
  filesDeleted: string[];
  /** Full unified diff string */
  unifiedDiff: string;
  /** Per-file diffs with hunks */
  perFileDiffs: FileDiff[];
  /** Summary statistics */
  stats: { additions: number; deletions: number; filesChanged: number };
}

export interface FileDiff {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  hunks: string;
}

// ============================================================
// Constants
// ============================================================

/** Maximum diff size to prevent blowing up review model context */
const MAX_DIFF_SIZE = 100 * 1024; // 100KB

// ============================================================
// Main API
// ============================================================

/**
 * Diff Collector — static methods for extracting git diffs in various contexts
 */
export class DiffCollector {
  /**
   * Get diff from a specific commit (used when we have a checkpoint)
   */
  static async collectDiffSinceCommit(
    workingDir: string,
    baseCommit: string,
  ): Promise<ReviewDiff> {
    try {
      // Get the diff from the base commit to HEAD
      const unifiedDiff = await execGitDiff(workingDir, `${baseCommit}..HEAD`);
      const nameStatus = await execGitNameStatus(workingDir, `${baseCommit}..HEAD`);
      const stats = await execGitStats(workingDir, `${baseCommit}..HEAD`);

      return parseDiffOutput(unifiedDiff, nameStatus, stats);
    } catch {
      // Not a git repo, invalid commit, or other git error
      return emptyDiff();
    }
  }

  /**
   * Get diff of staged changes
   */
  static async collectStagedDiff(workingDir: string): Promise<ReviewDiff> {
    try {
      const unifiedDiff = await execGitDiff(workingDir, '--cached');
      const nameStatus = await execGitNameStatus(workingDir, '--cached');
      const stats = await execGitStats(workingDir, '--cached');

      return parseDiffOutput(unifiedDiff, nameStatus, stats);
    } catch {
      return emptyDiff();
    }
  }

  /**
   * Get diff of all uncommitted changes (staged + unstaged)
   * This is the most common use case
   */
  static async collectWorkingDiff(workingDir: string): Promise<ReviewDiff> {
    try {
      let unifiedDiff = await execGitDiff(workingDir, 'HEAD');
      let nameStatus = await execGitNameStatus(workingDir, 'HEAD');
      const stats = await execGitStats(workingDir, 'HEAD');
      const untrackedFiles = await execGitUntrackedFiles(workingDir);

      if (untrackedFiles.length > 0) {
        const untrackedPatches = await Promise.all(
          untrackedFiles.map((filePath) => execGitNoIndexDiff(workingDir, filePath)),
        );
        unifiedDiff = [unifiedDiff, ...untrackedPatches].filter(Boolean).join('\n');
        const additions = untrackedFiles.map((filePath) => `A\t${filePath}`).join('\n');
        nameStatus = [nameStatus, additions].filter(Boolean).join('\n');
      }

      return parseDiffOutput(unifiedDiff, nameStatus, stats);
    } catch {
      return emptyDiff();
    }
  }

  /**
   * Get diff for specific files (used when we know which files a teammate modified)
   */
  static async collectDiffForFiles(
    workingDir: string,
    files: string[],
  ): Promise<ReviewDiff> {
    if (files.length === 0) {
      return emptyDiff();
    }

    try {
      const fileArgs = files.map((f) => `"${f}"`).join(' ');
      let unifiedDiff = await execGitDiff(workingDir, `HEAD -- ${fileArgs}`);
      let nameStatus = await execGitNameStatus(workingDir, `HEAD -- ${fileArgs}`);
      const stats = await execGitStats(workingDir, `HEAD -- ${fileArgs}`);
      const requestedFiles = new Set(files);
      const untrackedFiles = (await execGitUntrackedFiles(workingDir))
        .filter((filePath) => requestedFiles.has(filePath));

      if (untrackedFiles.length > 0) {
        const untrackedPatches = await Promise.all(
          untrackedFiles.map((filePath) => execGitNoIndexDiff(workingDir, filePath)),
        );
        unifiedDiff = [unifiedDiff, ...untrackedPatches].filter(Boolean).join('\n');
        const additions = untrackedFiles.map((filePath) => `A\t${filePath}`).join('\n');
        nameStatus = [nameStatus, additions].filter(Boolean).join('\n');
      }

      return parseDiffOutput(unifiedDiff, nameStatus, stats);
    } catch {
      return emptyDiff();
    }
  }
}

// ============================================================
// Git Command Execution
// ============================================================

/**
 * Execute git diff with the given arguments
 */
async function execGitDiff(workingDir: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git diff ${args}`, {
      cwd: workingDir,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer — we truncate after
    });
    return truncateDiff(stdout);
  } catch (error: unknown) {
    // If there's no diff, git returns empty output (not an error)
    if (error && typeof error === 'object' && 'stdout' in error) {
      return truncateDiff((error as { stdout: string }).stdout || '');
    }
    throw error;
  }
}

/**
 * Execute git diff --name-status to categorize file changes
 */
async function execGitNameStatus(workingDir: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git diff --name-status ${args}`, {
      cwd: workingDir,
      timeout: 10000,
    });
    return stdout;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      return (error as { stdout: string }).stdout || '';
    }
    throw error;
  }
}

/**
 * Execute git diff --stat to get summary statistics
 */
async function execGitStats(workingDir: string, args: string): Promise<string> {
  try {
    const { stdout } = await execAsync(`git diff --stat ${args}`, {
      cwd: workingDir,
      timeout: 10000,
    });
    return stdout;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      return (error as { stdout: string }).stdout || '';
    }
    throw error;
  }
}

/**
 * List untracked files in the working tree.
 */
async function execGitUntrackedFiles(workingDir: string): Promise<string[]> {
  try {
    const { stdout } = await execAsync('git ls-files --others --exclude-standard', {
      cwd: workingDir,
      timeout: 10000,
    });
    return stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Build a synthetic diff for an untracked file by comparing it against /dev/null.
 */
async function execGitNoIndexDiff(workingDir: string, relativePath: string): Promise<string> {
  const escaped = relativePath.replace(/"/g, '\\"');
  try {
    const { stdout } = await execAsync(`git diff --no-index -- /dev/null "${escaped}"`, {
      cwd: workingDir,
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return truncateDiff(stdout);
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'stdout' in error) {
      return truncateDiff((error as { stdout: string }).stdout || '');
    }
    return '';
  }
}

// ============================================================
// Parsing Logic
// ============================================================

/**
 * Parse git diff output into a structured ReviewDiff
 */
function parseDiffOutput(
  unifiedDiff: string,
  nameStatus: string,
  statsOutput: string,
): ReviewDiff {
  if (!unifiedDiff.trim() && !nameStatus.trim()) {
    return emptyDiff();
  }

  // Parse name-status to categorize files
  const { filesAdded, filesChanged, filesDeleted } = parseNameStatus(nameStatus);

  // Parse stats
  const stats = parseStats(statsOutput);
  if (stats.filesChanged === 0) {
    stats.filesChanged = filesAdded.length + filesChanged.length + filesDeleted.length;
  }

  // Split unified diff into per-file diffs
  const perFileDiffs = splitDiffByFile(unifiedDiff, filesAdded, filesDeleted);

  return {
    filesChanged,
    filesAdded,
    filesDeleted,
    unifiedDiff,
    perFileDiffs,
    stats,
  };
}

/**
 * Parse git diff --name-status output
 * Format: <status>\t<path>
 * Status: A (added), M (modified), D (deleted), R (renamed)
 */
function parseNameStatus(output: string): {
  filesAdded: string[];
  filesChanged: string[];
  filesDeleted: string[];
} {
  const filesAdded: string[] = [];
  const filesChanged: string[] = [];
  const filesDeleted: string[] = [];

  const lines = output.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const [status, ...pathParts] = line.split('\t');
    const path = pathParts.join('\t'); // Handle paths with tabs

    if (!status || !path) continue;

    if (status.startsWith('A')) {
      filesAdded.push(path);
    } else if (status.startsWith('D')) {
      filesDeleted.push(path);
    } else if (status.startsWith('M')) {
      filesChanged.push(path);
    } else if (status.startsWith('R')) {
      // Renamed files: treat as modified
      const parts = path.split('\t');
      const targetPath = (parts.length > 1 && parts[1]) || path;
      filesChanged.push(targetPath);
    }
  }

  return { filesAdded, filesChanged, filesDeleted };
}

/**
 * Parse git diff --stat output to extract additions/deletions/files changed
 * Format (last line): " N files changed, X insertions(+), Y deletions(-)"
 */
function parseStats(output: string): {
  additions: number;
  deletions: number;
  filesChanged: number;
} {
  const lines = output.trim().split('\n');
  const summaryLine = lines[lines.length - 1];

  if (!summaryLine) {
    return { additions: 0, deletions: 0, filesChanged: 0 };
  }

  const filesMatch = summaryLine.match(/(\d+)\s+file/);
  const additionsMatch = summaryLine.match(/(\d+)\s+insertion/);
  const deletionsMatch = summaryLine.match(/(\d+)\s+deletion/);

  return {
    filesChanged: filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0,
    additions: additionsMatch?.[1] ? parseInt(additionsMatch[1], 10) : 0,
    deletions: deletionsMatch?.[1] ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

/**
 * Split unified diff into per-file diffs
 * Each file diff starts with "diff --git a/path b/path"
 */
function splitDiffByFile(
  unifiedDiff: string,
  filesAdded: string[],
  filesDeleted: string[],
): FileDiff[] {
  if (!unifiedDiff.trim()) return [];

  const fileDiffs: FileDiff[] = [];
  const diffBlocks = unifiedDiff.split(/(?=^diff --git)/m).filter(Boolean);

  for (const block of diffBlocks) {
    const pathMatch = block.match(/^diff --git a\/(.+?) b\/(.+?)$/m);
    const filePath = pathMatch?.[2];
    if (!filePath) continue;

    let status: FileDiff['status'] = 'modified';
    if (filesAdded.includes(filePath)) {
      status = 'added';
    } else if (filesDeleted.includes(filePath)) {
      status = 'deleted';
    } else if (block.includes('rename from')) {
      status = 'renamed';
    }

    fileDiffs.push({
      path: filePath,
      status,
      hunks: block,
    });
  }

  return fileDiffs;
}

/**
 * Truncate very large diffs to avoid blowing up review model context
 */
function truncateDiff(diff: string): string {
  if (diff.length <= MAX_DIFF_SIZE) {
    return diff;
  }

  const truncated = diff.slice(0, MAX_DIFF_SIZE);
  const lastNewline = truncated.lastIndexOf('\n');
  const trimmed = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;

  return `${trimmed}\n\n[... diff truncated at ${MAX_DIFF_SIZE} bytes ...]`;
}

/**
 * Return an empty diff structure
 */
function emptyDiff(): ReviewDiff {
  return {
    filesChanged: [],
    filesAdded: [],
    filesDeleted: [],
    unifiedDiff: '',
    perFileDiffs: [],
    stats: { additions: 0, deletions: 0, filesChanged: 0 },
  };
}
