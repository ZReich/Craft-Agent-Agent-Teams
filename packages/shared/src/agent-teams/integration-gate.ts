/**
 * Integration Verification Gate
 *
 * Runs after ALL individual tasks pass their quality gates.
 * Verifies the combined work of all teammates doesn't break
 * the project when integrated together.
 *
 * Checks:
 *   1. TypeScript compilation across the entire project
 *   2. Full test suite (not task-scoped)
 *   3. Git status for merge conflicts
 *   4. Identifies which teammate's changes caused any failures
 */

import { EventEmitter } from 'events';
import { exec } from 'child_process';
import { promisify } from 'util';
import { runTypeCheckCached, runTestSuiteCached } from './local-checks';

const execAsync = promisify(exec);

// ============================================================
// Types
// ============================================================

export interface IntegrationCheckResult {
  /** Whether all integration checks passed */
  passed: boolean;
  /** TypeScript compilation result */
  typeCheck: {
    passed: boolean;
    errorCount: number;
    errors: string[];
  };
  /** Full test suite result */
  testSuite: {
    passed: boolean;
    total: number;
    passed_count: number;
    failed: number;
    skipped: number;
    failedTests: string[];
  };
  /** Git conflict check */
  conflicts: {
    hasConflicts: boolean;
    conflictFiles: string[];
  };
  /** Which teammates' changes may have caused failures */
  brokenBy: string[];
  /** When the check ran */
  timestamp: string;
  /** How long the check took (ms) */
  durationMs: number;
}

export interface IntegrationGateConfig {
  /** Working directory for checks */
  workingDirectory: string;
  /** Timeout for type checking (ms). Default: 60000 */
  typeCheckTimeoutMs: number;
  /** Timeout for test suite (ms). Default: 180000 (3 min) */
  testSuiteTimeoutMs: number;
  /** Whether to skip tests (useful if only checking compilation). Default: false */
  skipTests: boolean;
  /** Optional cache namespace for local compile/test checks */
  localCheckCacheKey?: string;
}

export const DEFAULT_INTEGRATION_CONFIG: Partial<IntegrationGateConfig> = {
  typeCheckTimeoutMs: 60000,
  testSuiteTimeoutMs: 180000,
  skipTests: false,
};

// ============================================================
// Integration Gate
// ============================================================

export class IntegrationGate extends EventEmitter {
  private config: IntegrationGateConfig;

  constructor(config: IntegrationGateConfig) {
    super();
    this.config = {
      ...DEFAULT_INTEGRATION_CONFIG,
      ...config,
    } as IntegrationGateConfig;
  }

  /**
   * Run the full integration verification suite.
   * This checks the entire project, not just individual task diffs.
   */
  async runCheck(): Promise<IntegrationCheckResult> {
    const startTime = Date.now();
    const workDir = this.config.workingDirectory;

    this.emit('integration:started', { workingDirectory: workDir });

    // Run type check and conflict check in parallel (tests are slower, run after)
    const [typeCheck, conflicts] = await Promise.all([
      this.runTypeCheck(workDir),
      this.checkGitConflicts(workDir),
    ]);

    // Run tests only if type check passes (no point testing broken code)
    let testSuite: IntegrationCheckResult['testSuite'];
    if (typeCheck.passed && !this.config.skipTests) {
      testSuite = await this.runTestSuite(workDir);
    } else if (this.config.skipTests) {
      testSuite = { passed: true, total: 0, passed_count: 0, failed: 0, skipped: 0, failedTests: [] };
    } else {
      testSuite = { passed: false, total: 0, passed_count: 0, failed: 0, skipped: 0, failedTests: ['Skipped — type check failed'] };
    }

    const passed = typeCheck.passed && testSuite.passed && !conflicts.hasConflicts;
    const durationMs = Date.now() - startTime;

    // Try to identify who broke it if it failed
    let brokenBy: string[] = [];
    if (!passed && (typeCheck.errors.length > 0 || testSuite.failedTests.length > 0)) {
      brokenBy = await this.identifyBreakers(
        workDir,
        typeCheck.errors,
        testSuite.failedTests,
      );
    }

    const result: IntegrationCheckResult = {
      passed,
      typeCheck,
      testSuite,
      conflicts,
      brokenBy,
      timestamp: new Date().toISOString(),
      durationMs,
    };

    this.emit('integration:completed', result);
    return result;
  }

  /**
   * Run TypeScript compilation on the full project.
   */
  private async runTypeCheck(workDir: string): Promise<IntegrationCheckResult['typeCheck']> {
    const result = await runTypeCheckCached({
      workingDir: workDir,
      timeoutMs: this.config.typeCheckTimeoutMs,
      cacheKey: this.config.localCheckCacheKey
        ? `${this.config.localCheckCacheKey}:typecheck`
        : undefined,
    });
    return {
      passed: result.passed,
      errorCount: result.errorCount,
      errors: result.errors,
    };
  }

  /**
   * Run the full test suite.
   */
  private async runTestSuite(workDir: string): Promise<IntegrationCheckResult['testSuite']> {
    const result = await runTestSuiteCached({
      workingDir: workDir,
      timeoutMs: this.config.testSuiteTimeoutMs,
      cacheKey: this.config.localCheckCacheKey
        ? `${this.config.localCheckCacheKey}:tests`
        : undefined,
    });
    return {
      passed: result.passed,
      total: result.total,
      passed_count: result.passed_count,
      failed: result.failed,
      skipped: result.skipped,
      failedTests: result.failedTests,
    };
  }

  /**
   * Check for git merge conflicts in the working directory.
   */
  private async checkGitConflicts(workDir: string): Promise<IntegrationCheckResult['conflicts']> {
    try {
      const { stdout } = await execAsync('git diff --name-only --diff-filter=U', {
        cwd: workDir,
        timeout: 10000,
      });

      const conflictFiles = stdout.trim().split('\n').filter(Boolean);
      return {
        hasConflicts: conflictFiles.length > 0,
        conflictFiles,
      };
    } catch {
      // If git command fails, no conflicts detectable
      return { hasConflicts: false, conflictFiles: [] };
    }
  }

  /**
   * Try to identify which recent committers/changes caused the failures.
   * Uses git blame on files with errors to find who changed them.
   */
  private async identifyBreakers(
    workDir: string,
    typeErrors: string[],
    failedTests: string[],
  ): Promise<string[]> {
    const breakers = new Set<string>();

    // Extract file paths from type errors (format: "path/to/file.ts(line,col): error TS...")
    const errorFiles = typeErrors
      .map(e => e.match(/^([^(]+)\(/)?.[1])
      .filter(Boolean) as string[];

    // Get recent committers for files with errors
    for (const filePath of errorFiles.slice(0, 10)) {
      try {
        const { stdout } = await execAsync(
          `git log -1 --format="%an" -- "${filePath}"`,
          { cwd: workDir, timeout: 5000 },
        );
        const author = stdout.trim();
        if (author) breakers.add(author);
      } catch {
        // Ignore individual file failures
      }
    }

    return Array.from(breakers);
  }
}
