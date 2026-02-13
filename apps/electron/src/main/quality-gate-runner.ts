/**
 * Quality Gate Runner
 *
 * Orchestrates the quality gate pipeline for teammate work.
 * Runs local checks (syntax, tests) and AI reviews (architecture,
 * simplicity, errors, completeness) before teammate work is relayed
 * to the team lead.
 *
 * Uses Kimi K2.5 (Moonshot) by default for AI reviews, with Sonnet
 * as the escalation model when reviews are ambiguous or stuck.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import log from './logger';
import {
  computeAggregateScore,
  shouldPass,
  formatFailureReport,
  formatSuccessReport,
} from '@craft-agent/shared/agent-teams/quality-gates';
import type {
  QualityGateConfig,
  QualityGateResult,
  QualityGateStageResult,
  TestStageResult,
  QualityGateStageName,
  TaskType,
  TDDPhase,
  Spec,
  SpecRequirement,
} from '@craft-agent/core/types';
import { resolveReviewProvider, type ReviewProvider } from '@craft-agent/shared/agent-teams/review-provider';

const execAsync = promisify(exec);
const qgLog = log.scope('quality-gates');

// ============================================================
// AI Review Prompt Templates
// ============================================================

const REVIEW_PROMPTS: Record<string, string> = {
  architecture: `You are a senior software architect reviewing code changes. Analyze the following diff for:
- Proper file organization and module boundaries
- Separation of concerns (UI, business logic, data access)
- Consistent patterns with the rest of the codebase
- No circular dependencies or tight coupling
- Appropriate abstraction level (not over-engineered, not under-engineered)

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "issues": [<string descriptions of problems found>],
  "suggestions": [<string suggestions for improvement>]
}

Score guide: 95-100 = excellent, 85-94 = good with minor issues, 70-84 = needs work, below 70 = significant problems.
Be specific in issues — reference file names and line patterns. Only flag real problems, not style preferences.`,

  simplicity: `You are a code reviewer focused on simplicity and readability. Analyze the following diff for:
- Unnecessary complexity or over-engineering
- Code that could be simpler without losing functionality
- Premature abstractions or unnecessary indirection
- Clear variable/function naming
- Functions that are too long or do too many things

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "issues": [<string descriptions of complexity problems>],
  "suggestions": [<string suggestions for simplification>]
}

Score guide: 95-100 = clean and simple, 85-94 = mostly clear, 70-84 = could be simpler, below 70 = overly complex.
Only flag genuine complexity issues. Three similar lines is fine — don't suggest premature abstraction.`,

  errors: `You are a reliability engineer reviewing code changes. Analyze the following diff for:
- Unhandled edge cases (null, undefined, empty arrays, boundary values)
- Missing error handling at system boundaries (API calls, file I/O, user input)
- Potential runtime exceptions (property access on possibly-null values)
- Security issues (injection, XSS, command injection, path traversal)
- Race conditions or concurrency issues
- Resource leaks (unclosed handles, missing cleanup)

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "issues": [<string descriptions of error-prone code>],
  "suggestions": [<string suggestions for making code more robust>]
}

Score guide: 95-100 = robust, 85-94 = mostly safe, 70-84 = has gaps, below 70 = risky.
Focus on real risks, not hypothetical scenarios. Trust internal code — only validate at boundaries.`,

  completeness: `You are a QA engineer checking if the implementation is complete AND fully integrated. Analyze the following diff against the task description.

## CRITICAL — Integration Verification

This is the MOST IMPORTANT part of your review. Building code that is never used is a critical defect. You MUST verify:

1. **New components are imported and rendered** — Every new React component must be imported and mounted in a parent. Dead components are a FAIL.
2. **New functions are called** — Every new function/method must have at least one call site in the codebase. Orphan functions are a FAIL.
3. **New IPC handlers have listeners** — Every new IPC handler registered in main process must be exposed in preload and called from renderer. Disconnected IPC is a FAIL.
4. **New types are used at runtime** — Type definitions that are never referenced by runtime code suggest incomplete integration.
5. **New event emitters have subscribers** — Events that are emitted but never listened to indicate missing integration.
6. **New CSS/styles are applied** — Stylesheets or class definitions that are never used in markup are dead code.

If ANY of the above checks fail, set "integrationVerified" to false. This is an automatic FAIL regardless of other scores.

## Standard Completeness Checks

- All requirements addressed (nothing missing from the task description)
- No TODO/FIXME/HACK comments left in code
- No half-implemented features (stubs, placeholder values, commented-out code)
- No missing exports, imports, or type definitions needed by consumers

Task description: {taskDescription}

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "integrationVerified": <boolean — false if ANY new code is not connected to existing code>,
  "issues": [<string descriptions of missing or incomplete items>],
  "suggestions": [<string suggestions for completing the work>]
}

Score guide: 95-100 = fully complete and integrated, 85-94 = nearly done, 70-84 = gaps remain, below 70 = substantially incomplete.
CRITICAL: If integrationVerified is false, score MUST be below 70 regardless of other factors. Dead code is never acceptable.`,
};

// ============================================================
// Types
// ============================================================

export interface TaskContext {
  /** Description of what the teammate was asked to do */
  taskDescription: string;
  /** Working directory for local checks */
  workingDirectory?: string;
  /** Type of task (for TDD enforcement) */
  taskType?: TaskType;
  /** Current TDD phase */
  tddPhase?: TDDPhase;
  /** Optional SDD specification context (used by SDD quality gate stages) */
  spec?: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>;
}

interface ApiKeyProvider {
  getMoonshotApiKey(): Promise<string | null>;
  getAnthropicApiKey(): Promise<string | null>;
  getOpenAiConfig(): Promise<{ apiKey: string; baseUrl?: string | null } | null>;
}

// ============================================================
// Quality Gate Runner
// ============================================================

export class QualityGateRunner {
  private apiKeyProvider: ApiKeyProvider;

  constructor(apiKeyProvider: ApiKeyProvider) {
    this.apiKeyProvider = apiKeyProvider;
  }

  private serializeError(error: unknown): { message: string; name?: string; stack?: string; cause?: string } {
    if (error instanceof Error) {
      return {
        message: error.message,
        name: error.name,
        stack: error.stack,
        cause: error.cause ? String(error.cause) : undefined,
      };
    }

    return {
      message: typeof error === 'string' ? error : JSON.stringify(error),
    };
  }

  private createStageFailureResult(message: string, suggestions: string[] = []): QualityGateStageResult {
    return {
      score: 0,
      passed: false,
      issues: [message],
      suggestions,
    };
  }

  private async validateReviewProviderAccess(reviewProvider: ReviewProvider): Promise<string | null> {
    if (reviewProvider === 'moonshot') {
      const key = await this.apiKeyProvider.getMoonshotApiKey();
      return key ? null : 'Moonshot credential is missing for the selected review model/provider';
    }

    if (reviewProvider === 'openai') {
      const cfg = await this.apiKeyProvider.getOpenAiConfig();
      return cfg?.apiKey ? null : 'OpenAI credential is missing for the selected review model/provider';
    }

    const key = await this.apiKeyProvider.getAnthropicApiKey();
    return key ? null : 'Anthropic credential is missing for the selected review model/provider';
  }

  /**
   * Run the full quality gate pipeline on a teammate's work.
   */
  async runPipeline(
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
    spec?: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
  ): Promise<QualityGateResult> {
    qgLog.info('[QualityGates] Starting pipeline run');
    const reviewProvider = resolveReviewProvider(config.reviewModel, config.reviewProvider);
    const activeSpec = spec ?? taskContext.spec;

    const stages: QualityGateResult['stages'] = {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 0, passedTests: 0, failedTests: 0, skippedTests: 0 } as TestStageResult,
      architecture: { score: 100, passed: true, issues: [], suggestions: [] },
      simplicity: { score: 100, passed: true, issues: [], suggestions: [] },
      errors: { score: 100, passed: true, issues: [], suggestions: [] },
      completeness: { score: 100, passed: true, issues: [], suggestions: [] },
    };

    // Stage 1: Syntax & Types (local, free)
    if (config.stages.syntax.enabled && taskContext.workingDirectory) {
      qgLog.info('[QualityGates] Running syntax check');
      stages.syntax = await this.runSyntaxCheck(taskContext.workingDirectory);
    }

    // Stage 2: Test Execution (local, free)
    if (config.stages.tests.enabled && taskContext.workingDirectory) {
      qgLog.info('[QualityGates] Running test execution');
      stages.tests = await this.runTestExecution(taskContext.workingDirectory);
    }

    // Early exit if binary gates fail — no point running AI reviews
    if (config.stages.syntax.enabled && !stages.syntax.passed) {
      qgLog.info('[QualityGates] Syntax check failed, skipping AI reviews');
      return this.buildResult(stages, config, reviewProvider);
    }
    if (config.stages.tests.enabled && !stages.tests.passed) {
      qgLog.info('[QualityGates] Tests failed, skipping AI reviews');
      return this.buildResult(stages, config, reviewProvider);
    }

    // TDD enforcement: if enabled and task is a feature, check test-first discipline
    if (config.enforceTDD && taskContext.taskType === 'feature') {
      const tddPhase = taskContext.tddPhase || this.detectTDDPhase(diff);
      const tddResult = this.enforceTestFirst(diff, { ...taskContext, tddPhase });
      if (tddResult && !tddResult.passed) {
        qgLog.info('[QualityGates] TDD enforcement failed — no test files in diff');
        // Inject TDD failure into the completeness stage
        stages.completeness = tddResult;
        return this.buildResult(stages, config, reviewProvider);
      }
    }

    // Stages 3-6: AI Reviews (parallel for speed)
    type AIReviewStage = 'architecture' | 'simplicity' | 'errors' | 'completeness';
    const aiStages: AIReviewStage[] = ['architecture', 'simplicity', 'errors', 'completeness'];
    const enabledAiStages = aiStages.filter(s => config.stages[s].enabled);

    if (enabledAiStages.length > 0) {
      const providerAccessError = await this.validateReviewProviderAccess(reviewProvider);
      if (providerAccessError) {
        qgLog.error('[QualityGates] Review provider preflight failed:', providerAccessError);
        for (const stage of enabledAiStages) {
          stages[stage] = this.createStageFailureResult(
            providerAccessError,
            ['Configure valid credentials for the selected model/provider and retry quality gates'],
          );
        }
        return this.buildResult(stages, config, reviewProvider);
      }

      qgLog.info(`[QualityGates] Running ${enabledAiStages.length} AI review stages in parallel`);
      const aiResults = await Promise.allSettled(
        enabledAiStages.map(stage => this.runAIReview(stage, diff, taskContext, config, reviewProvider))
      );

      for (let i = 0; i < enabledAiStages.length; i++) {
        const stageName = enabledAiStages[i];
        const result = aiResults[i];
        if (result.status === 'fulfilled') {
          stages[stageName] = result.value;
        } else {
          const errorDetails = this.serializeError(result.reason);
          qgLog.error(`[QualityGates] AI review stage "${stageName}" failed:`, errorDetails);
          stages[stageName] = this.createStageFailureResult(
            `AI review stage "${stageName}" failed: ${errorDetails.message}`,
            ['Fix model/provider credentials or endpoint configuration, then rerun quality gates'],
          );
        }
      }
    }

    // SDD stages: run only when a spec is provided (backward-compatible by default)
    if (activeSpec && activeSpec.requirements.length > 0) {
      qgLog.info('[QualityGates] Running SDD review stages');

      if (config.stages.spec_compliance.enabled) {
        stages.spec_compliance = await this.runSpecComplianceReview(diff, taskContext, activeSpec, config, reviewProvider);
      }

      if (config.stages.traceability.enabled) {
        stages.traceability = await this.runTraceabilityReview(diff, taskContext, activeSpec, config, reviewProvider);
      }

      const shouldRunRolloutSafety =
        config.stages.rollout_safety.enabled &&
        Boolean(activeSpec.rolloutPlan || activeSpec.rollbackPlan || activeSpec.observabilityPlan);

      if (shouldRunRolloutSafety) {
        stages.rollout_safety = await this.runRolloutSafetyReview(diff, taskContext, activeSpec, config, reviewProvider);
      }
    } else {
      qgLog.info('[QualityGates] No spec provided; skipping SDD review stages');
    }

    return this.buildResult(stages, config, reviewProvider);
  }

  /**
   * Run TypeScript compilation check.
   */
  async runSyntaxCheck(workingDir: string, allowInstall = true): Promise<QualityGateStageResult> {
    try {
      await execAsync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: workingDir,
        timeout: 60000,
      });
      return { score: 100, passed: true, issues: [], suggestions: [] };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      const output = this.normalizeOutput(error.stdout || error.stderr || 'Unknown compilation error');
      if (this.isInfraTypeFailure(output) && allowInstall) {
        const installed = await this.ensureDependenciesInstalled(workingDir);
        if (installed) {
          return this.runSyntaxCheck(workingDir, false);
        }
      }
      if (this.isMissingTypeScript(output)) {
        try {
          await execAsync('bun run tsc --noEmit --pretty false 2>&1', {
            cwd: workingDir,
            timeout: 60000,
          });
          return { score: 100, passed: true, issues: [], suggestions: [] };
        } catch (bunErr: unknown) {
          const bunError = bunErr as { stdout?: string; stderr?: string };
          const bunOutput = (bunError.stdout || bunError.stderr || 'Unknown compilation error').trim();
          if (this.isInfraTypeFailure(bunOutput) && allowInstall) {
            const installed = await this.ensureDependenciesInstalled(workingDir);
            if (installed) {
              return this.runSyntaxCheck(workingDir, false);
            }
          }
          const bunErrors = bunOutput.split('\n').filter(l => l.includes('error TS'));
          if (!bunOutput || bunErrors.length === 0 && /unknown compilation error/i.test(bunOutput)) {
            return {
              score: 100,
              passed: true,
              issues: [],
              suggestions: ['TypeScript check failed with an unknown error — install dependencies and re-run typecheck'],
            };
          }
          return {
            score: 0,
            passed: false,
            issues: bunErrors.length > 0 ? bunErrors.slice(0, 20) : [bunOutput.slice(0, 500)],
            suggestions: ['Fix all TypeScript compilation errors before proceeding'],
          };
        }
      }
      const errors = output.split('\n').filter(l => l.includes('error TS'));
      if (!output || errors.length === 0 && /unknown compilation error/i.test(output)) {
        return {
          score: 100,
          passed: true,
          issues: [],
          suggestions: ['TypeScript check failed with an unknown error — install dependencies and re-run typecheck'],
        };
      }
      if (this.isInfraTypeFailure(output) && allowInstall) {
        const installed = await this.ensureDependenciesInstalled(workingDir);
        if (installed) {
          return this.runSyntaxCheck(workingDir, false);
        }
      }
      return {
        score: 0,
        passed: false,
        issues: errors.length > 0 ? errors.slice(0, 20) : [output.slice(0, 500)],
        suggestions: ['Fix all TypeScript compilation errors before proceeding'],
      };
    }
  }

  /**
   * Run test suite and parse results.
   */
  async runTestExecution(workingDir: string, allowInstall = true): Promise<TestStageResult> {
    try {
      // Implements REQ-005: Don't redirect stderr to stdout to keep JSON output clean
      // ConfigWatcher logs go to stderr, vitest JSON goes to stdout - keep them separate!
      const { stdout } = await execAsync('npx vitest run --reporter=json -c vitest.config.ts', {
        cwd: workingDir,
        timeout: 120000,
        env: { ...process.env, CRAFT_DEBUG: '0' },
      });

      try {
        const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
        if (jsonMatch) {
          const results = JSON.parse(jsonMatch[0]);
          const passed = results.numPassedTests || 0;
          const failed = results.numFailedTests || 0;
          const skipped = results.numPendingTests || 0;
          const total = passed + failed + skipped;
          // Implements REQ-005: Fail when no test files are found
          if (total === 0) {
            return {
              score: 0,
              passed: false,
              issues: ['No test files found — tests are required for all feature work'],
              suggestions: ['Add unit tests for this change and re-run the quality gate'],
              totalTests: 0,
              passedTests: 0,
              failedTests: 0,
              skippedTests: 0,
            };
          }
          const infraDetails = JSON.stringify(results.testResults || []);
          if (failed > 0 && this.isInfraTestFailure(infraDetails) && allowInstall) {
            const installed = await this.ensureDependenciesInstalled(workingDir);
            if (installed) {
              return this.runTestExecution(workingDir, false);
            }
          }

          return {
            score: failed === 0 ? 100 : 0,
            passed: failed === 0,
            issues: failed > 0
              ? (results.testResults || [])
                  .filter((t: { status: string }) => t.status === 'failed')
                  .map((t: { name: string; message?: string }) => `FAIL: ${t.name}${t.message ? ` — ${t.message}` : ''}`)
                  .slice(0, 10)
              : [],
            suggestions: failed > 0 ? ['Fix all failing tests'] : [],
            totalTests: total,
            passedTests: passed,
            failedTests: failed,
            skippedTests: skipped,
          };
        }
      } catch {
        // JSON parse failed — fall through to text parsing
      }

      // Fallback: try to detect pass/fail from text output
      const hasFailure = /FAIL|failed/i.test(stdout);
      if (/no test files found/i.test(stdout)) {
        return {
          score: 0,
          passed: false,
          issues: ['No test files found — tests are required for all feature work'],
          suggestions: ['Add unit tests for this change and re-run the quality gate'],
          totalTests: 0,
          passedTests: 0,
          failedTests: 0,
          skippedTests: 0,
        };
      }
      return {
        score: hasFailure ? 0 : 100,
        passed: !hasFailure,
        issues: hasFailure ? ['Test execution reported failures — check test output'] : [],
        suggestions: hasFailure ? ['Fix all failing tests'] : [],
        totalTests: 0,
        passedTests: 0,
        failedTests: hasFailure ? 1 : 0,
        skippedTests: 0,
      };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number };
      const output = this.normalizeOutput(error.stdout || error.stderr || '');
      if (this.isMissingVitest(output) && allowInstall) {
        const installed = await this.ensureDependenciesInstalled(workingDir);
        if (installed) {
          return this.runTestExecution(workingDir, false);
        }
      }
      // Exit code 1 usually means test failures
      if (this.isInfraTestFailure(output) && allowInstall) {
        const installed = await this.ensureDependenciesInstalled(workingDir);
        if (installed) {
          return this.runTestExecution(workingDir, false);
        }
      }
      if (error.code === 1) {
        return {
          score: 0,
          passed: false,
          issues: ['Test suite failed — see output above', output.slice(0, 500)],
          suggestions: ['Fix all failing tests'],
          totalTests: 0,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
        };
      }
      // Other errors (e.g., no test runner found)
      qgLog.warn('[QualityGates] Test execution error:', error);
      return {
        score: 0,
        passed: false,
        issues: ['Test runner failed to execute — ensure dependencies are installed'],
        suggestions: ['Install dependencies and rerun tests'],
        totalTests: 0,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
      };
    }
  }

  private isInfraTypeFailure(output: string): boolean {
    return /(cannot find type definition|cannot find module|err_module_not_found|missing dependency|missing peer dependency|node_modules|please run (npm|pnpm|yarn|bun) install|no inputs were found in config file|ts18003|ts5058|cannot find a tsconfig\.json)/i.test(output);
  }

  private normalizeOutput(output: string): string {
    return output.replace(/\u001b\[[0-9;]*m/g, '').trim();
  }

  private isInfraTestFailure(output: string): boolean {
    return /(cannot find module|err_module_not_found|module not found|missing dependency|missing peer dependency|node_modules|please run (npm|pnpm|yarn|bun) install)/i.test(output);
  }

  private isMissingTypeScript(output: string): boolean {
    const normalized = this.normalizeOutput(output);
    return /not the tsc command/i.test(normalized)
      || /not the tsc command you are looking for/i.test(normalized)
      || (/typescript/i.test(normalized) && /not installed|missing|cannot find/i.test(normalized));
  }

  private isMissingVitest(output: string): boolean {
    const normalized = this.normalizeOutput(output);
    return /vitest/i.test(normalized) && (/not found|missing|cannot find|not installed/i.test(normalized) || /not the vitest command/i.test(normalized));
  }

  private async runBunVitest(workingDir: string, allowInstall = true): Promise<TestStageResult> {
    try {
      // Implements REQ-005: Don't redirect stderr to stdout to keep JSON output clean
      const { stdout } = await execAsync('bunx vitest run --reporter=json -c vitest.config.ts', {
        cwd: workingDir,
        timeout: 120000,
      });

      const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
      if (jsonMatch) {
        const results = JSON.parse(jsonMatch[0]);
        const passed = results.numPassedTests || 0;
        const failed = results.numFailedTests || 0;
        const skipped = results.numPendingTests || 0;
        const total = passed + failed + skipped;
        // Implements REQ-005: Fail when no test files are found
        if (total === 0) {
          return {
            score: 0,
            passed: false,
            issues: ['No test files found — tests are required for all feature work'],
            suggestions: ['Add unit tests for this change and re-run the quality gate'],
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            skippedTests: 0,
          };
        }
        const infraDetails = JSON.stringify(results.testResults || []);
        if (failed > 0 && this.isInfraTestFailure(infraDetails) && allowInstall) {
          const installed = await this.ensureDependenciesInstalled(workingDir);
          if (installed) {
            return this.runBunVitest(workingDir, false);
          }
        }

        return {
          score: failed === 0 ? 100 : 0,
          passed: failed === 0,
          issues: failed > 0
            ? (results.testResults || [])
                .filter((t: { status: string }) => t.status === 'failed')
                .map((t: { name: string; message?: string }) => `FAIL: ${t.name}${t.message ? ` — ${t.message}` : ''}`)
                .slice(0, 10)
            : [],
          suggestions: failed > 0 ? ['Fix all failing tests'] : [],
          totalTests: total,
          passedTests: passed,
          failedTests: failed,
          skippedTests: skipped,
        };
      }

      const hasFailure = /FAIL|failed/i.test(stdout);
      if (/no test files found/i.test(stdout)) {
        return {
          score: 0,
          passed: false,
          issues: ['No test files found — tests are required for all feature work'],
          suggestions: ['Add unit tests for this change and re-run the quality gate'],
          totalTests: 0,
          passedTests: 0,
          failedTests: 0,
          skippedTests: 0,
        };
      }
      return {
        score: hasFailure ? 0 : 100,
        passed: !hasFailure,
        issues: hasFailure ? ['Test execution reported failures — check test output'] : [],
        suggestions: hasFailure ? ['Fix all failing tests'] : [],
        totalTests: 0,
        passedTests: 0,
        failedTests: hasFailure ? 1 : 0,
        skippedTests: 0,
      };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string; code?: number };
      const output = this.normalizeOutput(error.stdout || error.stderr || '');
      if (this.isInfraTestFailure(output) && allowInstall) {
        const installed = await this.ensureDependenciesInstalled(workingDir);
        if (installed) {
          return this.runBunVitest(workingDir, false);
        }
      }
      if (error.code === 1) {
        return {
          score: 0,
          passed: false,
          issues: ['Test suite failed — see output above', output.slice(0, 500)],
          suggestions: ['Fix all failing tests'],
          totalTests: 0,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
        };
      }

      qgLog.warn('[QualityGates] Bun vitest error:', error);
      return {
        score: 0,
        passed: false,
        issues: ['Test runner failed to execute — ensure dependencies are installed'],
        suggestions: ['Install dependencies and rerun tests'],
        totalTests: 0,
        passedTests: 0,
        failedTests: 1,
        skippedTests: 0,
      };
    }
  }

  private async ensureDependenciesInstalled(workingDir: string): Promise<boolean> {
    try {
      qgLog.info('[QualityGates] Installing dependencies (bun install)');
      await execAsync('bun install', {
        cwd: workingDir,
        timeout: 300000,
      });
      return true;
    } catch (err) {
      qgLog.error('[QualityGates] Dependency install failed:', err);
      return false;
    }
  }

  // Implements REQ-001: Root config scopes to core/shared/electron tests

  /**
   * Run a single AI review stage using the configured review model.
   */
  async runAIReview(
    stage: QualityGateStageName,
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<QualityGateStageResult> {
    const promptTemplate = REVIEW_PROMPTS[stage];
    if (!promptTemplate) {
      return { score: 100, passed: true, issues: [], suggestions: [] };
    }

    const prompt = promptTemplate.replace('{taskDescription}', taskContext.taskDescription || 'No description provided');

    const userMessage = `Here is the code diff to review:\n\n\`\`\`diff\n${diff.slice(0, 50000)}\`\`\`\n\nTask: ${taskContext.taskDescription || 'No description'}`;

    try {
      const responseText = await this.callReviewModel(prompt, userMessage, config, reviewProvider);

      // Parse the JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        qgLog.warn(`[QualityGates] AI review "${stage}" returned non-JSON response`);
        return this.createStageFailureResult(
          `AI review "${stage}" returned an unexpected non-JSON format`,
          ['Ensure the configured model supports structured JSON responses for review stages'],
        );
      }

      const parsed = JSON.parse(jsonMatch[0]);
      let score = Math.max(0, Math.min(100, Number(parsed.score) || 100));

      // Completeness stage: enforce integration verification auto-fail
      // Implements REQ-006: Fail when new code is not integrated
      if (stage === 'completeness' && parsed.integrationVerified === false) {
        score = Math.min(score, 65); // Cap below passing threshold
        const integrationIssue = 'INTEGRATION FAILURE: New code is not connected to existing code — components, functions, or handlers are dead code';
        const issues = Array.isArray(parsed.issues) ? parsed.issues : [];
        if (!issues.some((i: string) => i.includes('INTEGRATION FAILURE'))) {
          issues.unshift(integrationIssue);
        }
        return {
          score,
          passed: false,
          issues,
          suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
        };
      }

      return {
        score,
        passed: score >= 70,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch (err) {
      const errorDetails = this.serializeError(err);
      qgLog.error(`[QualityGates] AI review "${stage}" failed:`, errorDetails);
      return this.createStageFailureResult(
        `AI review stage "${stage}" encountered an error: ${errorDetails.message}`,
        ['Verify provider credentials and model compatibility for this review stage'],
      );
    }
  }

  /**
   * SDD stage: verify each spec requirement is addressed in the output diff.
   */
  async runSpecComplianceReview(
    diff: string,
    taskContext: TaskContext,
    spec: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<QualityGateStageResult> {
    const requirementsList = spec.requirements
      .map((req: SpecRequirement) => `- ${req.id} (${req.priority}): ${req.description}`)
      .join('\n');

    const systemPrompt = `You are reviewing code changes against a specification.
Check that each requirement is addressed in the implementation diff.

For every requirement:
- Mark status as "addressed", "partial", or "missing"
- Cite concrete evidence (files, functions, tests, or diff snippets)
- Add an issue for every missing requirement

Return JSON only:
{
  "coverage": [
    {
      "id": "<requirement id>",
      "status": "addressed|partial|missing",
      "evidence": ["<file or test reference>", "..."],
      "notes": "<optional note>"
    }
  ],
  "issues": ["<missing requirement or major gap>"],
  "suggestions": ["<actionable next step>"]
}`;

    const userMessage = `Task: ${taskContext.taskDescription || 'No task description provided'}

Specification requirements:
${requirementsList || '(No requirements provided)'}

Code diff to review:
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\``;

    try {
      const responseText = await this.callReviewModel(systemPrompt, userMessage, config, reviewProvider);
      const parsed = this.parseJsonObject(responseText);
      if (!parsed || !Array.isArray(parsed.coverage)) {
        return this.createStageFailureResult(
          'Spec compliance review returned an unexpected response format',
          ['Ensure the review model returns valid JSON and rerun spec compliance checks'],
        );
      }

      const totalRequirements = spec.requirements.length;
      const coverageById = new Map<string, { status: string; evidence: string[] }>();
      for (const entry of parsed.coverage as Array<{ id?: string; status?: string; evidence?: string[] }>) {
        if (!entry?.id) continue;
        coverageById.set(entry.id, {
          status: (entry.status || 'missing').toLowerCase(),
          evidence: Array.isArray(entry.evidence) ? entry.evidence : [],
        });
      }

      let weightedCovered = 0;
      const autoIssues: string[] = [];
      for (const req of spec.requirements) {
        const coverage = coverageById.get(req.id);
        if (!coverage || coverage.status === 'missing') {
          autoIssues.push(`Requirement ${req.id} is not addressed in the diff`);
          continue;
        }
        if (coverage.status === 'partial') {
          weightedCovered += 0.5;
          autoIssues.push(`Requirement ${req.id} appears only partially implemented`);
          continue;
        }
        weightedCovered += 1;
      }

      const score = totalRequirements > 0
        ? Math.round((weightedCovered / totalRequirements) * 100)
        : 100;
      const issues = [
        ...(Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === 'string') : []),
        ...autoIssues,
      ];
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: unknown) => typeof s === 'string')
        : [];

      return {
        score,
        passed: score >= 70,
        issues: Array.from(new Set(issues)),
        suggestions,
      };
    } catch (err) {
      const errorDetails = this.serializeError(err);
      qgLog.error('[QualityGates] Spec compliance review failed:', errorDetails);
      return this.createStageFailureResult(
        `Spec compliance stage encountered an error: ${errorDetails.message}`,
        ['Fix the review model/provider setup and rerun spec compliance checks'],
      );
    }
  }

  /**
   * SDD stage: verify requirement-to-implementation traceability.
   */
  async runTraceabilityReview(
    diff: string,
    taskContext: TaskContext,
    spec: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<QualityGateStageResult> {
    const requirementIds = spec.requirements.map((r: SpecRequirement) => r.id).join(', ');

    const systemPrompt = `You are checking requirement traceability.
For each requirement ID, verify it is referenced in code comments, test descriptions, or nearby implementation context in the diff.
If commit messages are not available, state that and focus on diff evidence.

Return JSON only:
{
  "traceability": [
    {
      "id": "<requirement id>",
      "files": ["<file path>", "..."],
      "tests": ["<test file or test name>", "..."],
      "references": ["<comment/reference snippet>", "..."],
      "status": "linked|partial|missing"
    }
  ],
  "issues": ["<traceability gaps>"],
  "suggestions": ["<how to improve traceability>"]
}`;

    const userMessage = `Task: ${taskContext.taskDescription || 'No task description provided'}
Requirement IDs: ${requirementIds || '(none)'}

Code diff to review:
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\``;

    try {
      const responseText = await this.callReviewModel(systemPrompt, userMessage, config, reviewProvider);
      const parsed = this.parseJsonObject(responseText);
      if (!parsed || !Array.isArray(parsed.traceability)) {
        return this.createStageFailureResult(
          'Traceability review returned an unexpected response format',
          ['Ensure the review model returns valid JSON and rerun traceability checks'],
        );
      }

      const rows = parsed.traceability as Array<{
        id?: string;
        files?: string[];
        tests?: string[];
        references?: string[];
        status?: string;
      }>;

      let linkedScore = 0;
      const mapSuggestions: string[] = [];
      const autoIssues: string[] = [];

      for (const req of spec.requirements) {
        const row = rows.find(r => r.id === req.id);
        if (!row) {
          autoIssues.push(`No traceability evidence found for requirement ${req.id}`);
          continue;
        }

        const status = (row.status || 'missing').toLowerCase();
        if (status === 'linked') {
          linkedScore += 1;
        } else if (status === 'partial') {
          linkedScore += 0.5;
          autoIssues.push(`Requirement ${req.id} has partial traceability`);
        } else {
          autoIssues.push(`Requirement ${req.id} is missing traceability links`);
        }

        const files = Array.isArray(row.files) ? row.files : [];
        const tests = Array.isArray(row.tests) ? row.tests : [];
        const refs = Array.isArray(row.references) ? row.references : [];
        const summary = [
          files.length > 0 ? `files: ${files.join(', ')}` : null,
          tests.length > 0 ? `tests: ${tests.join(', ')}` : null,
          refs.length > 0 ? `refs: ${refs.join(', ')}` : null,
        ].filter(Boolean).join(' | ');
        if (summary) {
          mapSuggestions.push(`${req.id} → ${summary}`);
        }
      }

      const score = spec.requirements.length > 0
        ? Math.round((linkedScore / spec.requirements.length) * 100)
        : 100;
      const issues = [
        ...(Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === 'string') : []),
        ...autoIssues,
      ];
      const suggestions = [
        ...(Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s: unknown) => typeof s === 'string') : []),
        ...mapSuggestions.map(m => `Traceability map: ${m}`),
      ];

      return {
        score,
        passed: score >= 70,
        issues: Array.from(new Set(issues)),
        suggestions,
      };
    } catch (err) {
      const errorDetails = this.serializeError(err);
      qgLog.error('[QualityGates] Traceability review failed:', errorDetails);
      return this.createStageFailureResult(
        `Traceability stage encountered an error: ${errorDetails.message}`,
        ['Fix the review model/provider setup and rerun traceability checks'],
      );
    }
  }

  /**
   * SDD stage: check rollout/rollback/observability safety concerns.
   * Runs only when rollout-related spec sections are present.
   */
  async runRolloutSafetyReview(
    diff: string,
    taskContext: TaskContext,
    spec: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<QualityGateStageResult> {
    const systemPrompt = `You are reviewing deployment safety.
Check that rollout and rollback expectations from the specification are represented in the diff.

Focus on:
- Rollback implementation feasibility and documented procedure
- Monitoring/observability hooks, alerts, dashboards, or metrics
- Feature flag usage or progressive rollout controls when applicable
- Operational safety risks that could make deployment unsafe

Return JSON only:
{
  "score": <number 0-100>,
  "checks": {
    "rollbackReady": true,
    "monitoringReady": true,
    "featureFlagReady": true
  },
  "issues": ["<deployment safety concern>"],
  "suggestions": ["<how to improve rollout safety>"]
}`;

    const userMessage = `Task: ${taskContext.taskDescription || 'No task description provided'}

Specification rollout context:
- rolloutPlan: ${spec.rolloutPlan || '(none)'}
- rollbackPlan: ${spec.rollbackPlan || '(none)'}
- observabilityPlan: ${spec.observabilityPlan || '(none)'}

Code diff to review:
\`\`\`diff
${diff.slice(0, 50000)}
\`\`\``;

    try {
      const responseText = await this.callReviewModel(systemPrompt, userMessage, config, reviewProvider);
      const parsed = this.parseJsonObject(responseText);
      if (!parsed) {
        return this.createStageFailureResult(
          'Rollout safety review returned an unexpected response format',
          ['Ensure the review model returns valid JSON and rerun rollout safety checks'],
        );
      }

      const reviewScore = Math.max(0, Math.min(100, Number(parsed.score) || 75));
      const checks = (typeof parsed.checks === 'object' && parsed.checks)
        ? parsed.checks as { rollbackReady?: boolean; monitoringReady?: boolean; featureFlagReady?: boolean }
        : {};

      const autoIssues: string[] = [];
      if (spec.rollbackPlan && checks.rollbackReady === false) {
        autoIssues.push('Spec includes a rollback plan, but rollback readiness evidence is missing in the diff');
      }
      if (spec.observabilityPlan && checks.monitoringReady === false) {
        autoIssues.push('Spec includes an observability plan, but monitoring/alerting evidence is missing in the diff');
      }
      if (spec.rolloutPlan && /flag|canary|gradual|progressive/i.test(spec.rolloutPlan) && checks.featureFlagReady === false) {
        autoIssues.push('Rollout plan suggests staged rollout controls, but feature-flag evidence is missing');
      }

      const issues = [
        ...(Array.isArray(parsed.issues) ? parsed.issues.filter(i => typeof i === 'string') : []),
        ...autoIssues,
      ];
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: unknown) => typeof s === 'string')
        : [];

      return {
        score: reviewScore,
        passed: reviewScore >= 70,
        issues: Array.from(new Set(issues)),
        suggestions,
      };
    } catch (err) {
      const errorDetails = this.serializeError(err);
      qgLog.error('[QualityGates] Rollout safety review failed:', errorDetails);
      return this.createStageFailureResult(
        `Rollout safety stage encountered an error: ${errorDetails.message}`,
        ['Fix the review model/provider setup and rerun rollout safety checks'],
      );
    }
  }

  /**
   * Extract the first JSON object from an LLM response.
   */
  private parseJsonObject(responseText: string): Record<string, unknown> | null {
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Call the review model (Kimi K2.5 by default, Anthropic Sonnet for escalation).
   */
  private async callReviewModel(
    systemPrompt: string,
    userMessage: string,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<string> {
    if (reviewProvider === 'moonshot') {
      return this.callMoonshotApi(systemPrompt, userMessage, config.reviewModel);
    }
    if (reviewProvider === 'openai') {
      return this.callOpenAiApi(systemPrompt, userMessage, config.reviewModel);
    }
    return this.callAnthropicApi(systemPrompt, userMessage, config.reviewModel);
  }

  /**
   * Call Moonshot (Kimi) API — OpenAI-compatible chat completions endpoint.
   */
  private async callMoonshotApi(
    systemPrompt: string,
    userMessage: string,
    model: string,
  ): Promise<string> {
    const apiKey = await this.apiKeyProvider.getMoonshotApiKey();
    if (!apiKey) {
      throw new Error('Moonshot API key not configured — required for quality gate reviews');
    }

    const temperature = model.toLowerCase().includes('k2.5') ? 1 : 0.1;
    const payload = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature,
      max_tokens: 2000,
    };

    const endpoints = [
      'https://api.moonshot.ai/v1/chat/completions',
      'https://api.moonshot.cn/v1/chat/completions',
    ];

    let lastError = 'Unknown Moonshot API error';
    for (const endpoint of endpoints) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json() as {
          choices: Array<{ message: { content: string } }>;
        };
        return data.choices[0]?.message?.content || '{}';
      }

      const errorText = await response.text();
      lastError = `Moonshot API error (${response.status}) @ ${endpoint}: ${errorText}`;

      // 401 is definitive for this key; stop retrying alternate host.
      if (response.status === 401) break;
    }

    throw new Error(lastError);
  }

  /**
   * Call Anthropic API (for escalation or max-quality preset reviewer).
   */
  private async callAnthropicApi(
    systemPrompt: string,
    userMessage: string,
    model: string,
  ): Promise<string> {
    const apiKey = await this.apiKeyProvider.getAnthropicApiKey();
    if (!apiKey) {
      throw new Error('Anthropic API key not configured — required for quality gate escalation');
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };
    const textBlock = data.content.find(b => b.type === 'text');
    return textBlock?.text || '{}';
  }

  /**
   * Call OpenAI/Codex API — OpenAI-compatible chat completions endpoint.
   */
  private async callOpenAiApi(
    systemPrompt: string,
    userMessage: string,
    model: string,
  ): Promise<string> {
    const config = await this.apiKeyProvider.getOpenAiConfig();
    if (!config?.apiKey) {
      throw new Error('OpenAI API key not configured — required for Codex quality gate reviews');
    }

    const baseUrl = (config.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const endpoint = baseUrl.endsWith('/v1')
      ? `${baseUrl}/chat/completions`
      : `${baseUrl}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content || typeof content !== 'string') {
      throw new Error('OpenAI API response missing content');
    }

    return content;
  }

  /**
   * Escalate to a more capable model for diagnosis.
   * Called when max review cycles are reached and work still doesn't pass.
   */
  async escalate(
    result: QualityGateResult,
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
  ): Promise<string> {
    qgLog.info('[QualityGates] Escalating to higher model for diagnosis');

    const escalationPrompt = `You are a senior engineer called in to diagnose why a teammate's code keeps failing quality reviews after ${result.cycleCount} attempts.

Here's the latest review result:
- Aggregate score: ${result.aggregateScore}/100 (needs ${config.passThreshold})
- Failed stages: ${Object.entries(result.stages).filter(([, s]) => !s.passed).map(([n]) => n).join(', ')}

Issues found:
${Object.entries(result.stages)
  .filter(([, s]) => s.issues.length > 0)
  .map(([name, s]) => `${name}: ${s.issues.join('; ')}`)
  .join('\n')}

Please analyze the diff and provide:
1. Root cause of the persistent failures
2. Specific, actionable steps to fix them
3. Whether the original task description was ambiguous or too complex`;

    try {
      const response = config.escalationProvider === 'moonshot'
        ? await this.callMoonshotApi(escalationPrompt, `Diff:\n\`\`\`\n${diff.slice(0, 50000)}\`\`\`\n\nTask: ${taskContext.taskDescription}`, config.escalationModel)
        : await this.callAnthropicApi(escalationPrompt, `Diff:\n\`\`\`\n${diff.slice(0, 50000)}\`\`\`\n\nTask: ${taskContext.taskDescription}`, config.escalationModel);

      return response;
    } catch (err) {
      qgLog.error('[QualityGates] Escalation failed:', err);
      return 'Escalation failed — manual review required.';
    }
  }

  // ============================================================
  // TDD Enforcement
  // ============================================================

  /**
   * Check if test files exist in the diff (for TDD enforcement).
   * Returns issues if the task is a feature and no test files are found.
   */
  enforceTestFirst(
    diff: string,
    taskContext: TaskContext,
  ): QualityGateStageResult | null {
    if (taskContext.taskType !== 'feature') return null;
    if (taskContext.tddPhase !== 'test-writing') return null;

    const testFilePatterns = [
      /\+\+\+.*\.test\.[jt]sx?/,
      /\+\+\+.*\.spec\.[jt]sx?/,
      /\+\+\+.*__tests__\//,
      /\+\+\+.*\.test\./,
    ];

    const hasTestFiles = testFilePatterns.some(p => p.test(diff));

    if (!hasTestFiles) {
      return {
        score: 0,
        passed: false,
        issues: ['No test files found in this change. TDD requires writing tests FIRST for new features.'],
        suggestions: [
          'Create test files before writing implementation code',
          'Name test files with .test.ts or .spec.ts suffix',
          'Write tests that describe the expected behavior, then implement to make them pass',
        ],
      };
    }

    // Check for meaningful tests (not just empty test files)
    const hasAssertions = /expect\(|assert|toBe|toEqual|toContain|toThrow|toHaveBeenCalled/.test(diff);
    if (!hasAssertions) {
      return {
        score: 30,
        passed: false,
        issues: ['Test files found but they appear to contain no assertions. Tests must be meaningful.'],
        suggestions: [
          'Add assertions using expect() or assert()',
          'Each test should verify specific behavior',
          'Test edge cases and error paths, not just the happy path',
        ],
      };
    }

    return {
      score: 100,
      passed: true,
      issues: [],
      suggestions: [],
    };
  }

  /**
   * Detect the TDD phase based on the diff content.
   */
  detectTDDPhase(diff: string): TDDPhase {
    const testFilePatterns = [
      /\+\+\+.*\.test\.[jt]sx?/,
      /\+\+\+.*\.spec\.[jt]sx?/,
    ];
    const implFilePatterns = [
      /\+\+\+.*(?<!\.test|\.spec)\.[jt]sx?$/m,
    ];

    const hasTestChanges = testFilePatterns.some(p => p.test(diff));
    const hasImplChanges = implFilePatterns.some(p => p.test(diff));

    if (hasTestChanges && !hasImplChanges) return 'test-writing';
    if (hasTestChanges && hasImplChanges) return 'implementing';
    return 'review';
  }

  // ============================================================
  // Internal Helpers
  // ============================================================

  private buildResult(
    stages: QualityGateResult['stages'],
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): QualityGateResult {
    const aggregateScore = computeAggregateScore(stages, config.stages);

    const result: QualityGateResult = {
      passed: false,
      aggregateScore,
      stages,
      cycleCount: 1,
      maxCycles: config.maxReviewCycles,
      reviewModel: config.reviewModel,
      reviewProvider,
      timestamp: new Date().toISOString(),
    };

    result.passed = shouldPass(result, config);
    return result;
  }
}

// ============================================================
// Export Helpers (re-exported from quality-gates.ts for convenience)
// ============================================================

export { formatFailureReport, formatSuccessReport };
