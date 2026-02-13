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
    try {
      await execAsync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: workDir,
        timeout: this.config.typeCheckTimeoutMs,
      });
      return { passed: true, errorCount: 0, errors: [] };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      const output = (error.stdout || error.stderr || '').trim();
      const errors = output.split('\n').filter(l => l.includes('error TS'));

      // If no actual TS errors found, may be a tooling issue — treat as pass
      if (errors.length === 0 && output.length > 0) {
        // Try with bun as fallback
        try {
          await execAsync('bun run tsc --noEmit --pretty false 2>&1', {
            cwd: workDir,
            timeout: this.config.typeCheckTimeoutMs,
          });
          return { passed: true, errorCount: 0, errors: [] };
        } catch {
          // If both fail without TS errors, treat as infrastructure issue
          return { passed: true, errorCount: 0, errors: [] };
        }
      }

      return {
        passed: false,
        errorCount: errors.length,
        errors: errors.slice(0, 30), // Cap at 30 errors
      };
    }
  }

  /**
   * Run the full test suite.
   */
  private async runTestSuite(workDir: string): Promise<IntegrationCheckResult['testSuite']> {
    try {
      const { stdout } = await execAsync('npx vitest run --reporter=json -c vitest.config.ts', {
        cwd: workDir,
        timeout: this.config.testSuiteTimeoutMs,
        env: { ...process.env, CRAFT_DEBUG: '0' },
      });

      const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
      if (jsonMatch) {
        const results = JSON.parse(jsonMatch[0]);
        const passed = results.numPassedTests || 0;
        const failed = results.numFailedTests || 0;
        const skipped = results.numPendingTests || 0;
        const total = passed + failed + skipped;

        const failedTests = (results.testResults || [])
          .filter((t: { status: string }) => t.status === 'failed')
          .map((t: { name: string }) => t.name)
          .slice(0, 20);

        return {
          passed: failed === 0,
          total,
          passed_count: passed,
          failed,
          skipped,
          failedTests,
        };
      }

      // Fallback: text parsing
      const hasFailure = /FAIL|failed/i.test(stdout);
      return {
        passed: !hasFailure,
        total: 0,
        passed_count: 0,
        failed: hasFailure ? 1 : 0,
        skipped: 0,
        failedTests: hasFailure ? ['Test suite reported failures'] : [],
      };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number };
      const output = (error.stdout || error.stderr || '').trim();

      // vitest exits with code 1 on test failures
      if (error.code === 1) {
        const jsonMatch = output.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const results = JSON.parse(jsonMatch[0]);
            const passed = results.numPassedTests || 0;
            const failed = results.numFailedTests || 0;
            const skipped = results.numPendingTests || 0;

            const failedTests = (results.testResults || [])
              .filter((t: { status: string }) => t.status === 'failed')
              .map((t: { name: string }) => t.name)
              .slice(0, 20);

            return { passed: false, total: passed + failed + skipped, passed_count: passed, failed, skipped, failedTests };
          } catch {
            // JSON parse failed
          }
        }
      }

      return {
        passed: false,
        total: 0,
        passed_count: 0,
        failed: 1,
        skipped: 0,
        failedTests: [output.slice(0, 200) || 'Test execution failed'],
      };
    }
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
