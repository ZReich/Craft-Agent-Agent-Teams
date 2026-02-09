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
} from '@craft-agent/core/types';

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

  completeness: `You are a QA engineer checking if the implementation is complete. Analyze the following diff against the task description for:
- All requirements addressed (nothing missing from the task description)
- No TODO/FIXME/HACK comments left in code
- No half-implemented features (stubs, placeholder values, commented-out code)
- No missing exports, imports, or type definitions needed by consumers
- Integration points properly connected (not just isolated code)

Task description: {taskDescription}

Return a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "issues": [<string descriptions of missing or incomplete items>],
  "suggestions": [<string suggestions for completing the work>]
}

Score guide: 95-100 = fully complete, 85-94 = nearly done, 70-84 = gaps remain, below 70 = substantially incomplete.`,
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
}

interface ApiKeyProvider {
  getMoonshotApiKey(): Promise<string | null>;
  getAnthropicApiKey(): Promise<string | null>;
}

// ============================================================
// Quality Gate Runner
// ============================================================

export class QualityGateRunner {
  private apiKeyProvider: ApiKeyProvider;

  constructor(apiKeyProvider: ApiKeyProvider) {
    this.apiKeyProvider = apiKeyProvider;
  }

  /**
   * Run the full quality gate pipeline on a teammate's work.
   */
  async runPipeline(
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
  ): Promise<QualityGateResult> {
    qgLog.info('[QualityGates] Starting pipeline run');

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
      return this.buildResult(stages, config);
    }
    if (config.stages.tests.enabled && !stages.tests.passed) {
      qgLog.info('[QualityGates] Tests failed, skipping AI reviews');
      return this.buildResult(stages, config);
    }

    // TDD enforcement: if enabled and task is a feature, check test-first discipline
    if (config.enforceTDD && taskContext.taskType === 'feature') {
      const tddPhase = taskContext.tddPhase || this.detectTDDPhase(diff);
      const tddResult = this.enforceTestFirst(diff, { ...taskContext, tddPhase });
      if (tddResult && !tddResult.passed) {
        qgLog.info('[QualityGates] TDD enforcement failed — no test files in diff');
        // Inject TDD failure into the completeness stage
        stages.completeness = tddResult;
        return this.buildResult(stages, config);
      }
    }

    // Stages 3-6: AI Reviews (parallel for speed)
    type AIReviewStage = 'architecture' | 'simplicity' | 'errors' | 'completeness';
    const aiStages: AIReviewStage[] = ['architecture', 'simplicity', 'errors', 'completeness'];
    const enabledAiStages = aiStages.filter(s => config.stages[s].enabled);

    if (enabledAiStages.length > 0) {
      qgLog.info(`[QualityGates] Running ${enabledAiStages.length} AI review stages in parallel`);
      const aiResults = await Promise.allSettled(
        enabledAiStages.map(stage => this.runAIReview(stage, diff, taskContext, config))
      );

      for (let i = 0; i < enabledAiStages.length; i++) {
        const stageName = enabledAiStages[i];
        const result = aiResults[i];
        if (result.status === 'fulfilled') {
          stages[stageName] = result.value;
        } else {
          qgLog.error(`[QualityGates] AI review stage "${stageName}" failed:`, result.reason);
          // On AI failure, give a passing score to avoid blocking on infra issues
          stages[stageName] = {
            score: 80,
            passed: true,
            issues: ['AI review stage encountered an error — manual review recommended'],
            suggestions: [],
          };
        }
      }
    }

    return this.buildResult(stages, config);
  }

  /**
   * Run TypeScript compilation check.
   */
  async runSyntaxCheck(workingDir: string): Promise<QualityGateStageResult> {
    try {
      await execAsync('npx tsc --noEmit --pretty false 2>&1', {
        cwd: workingDir,
        timeout: 60000,
      });
      return { score: 100, passed: true, issues: [], suggestions: [] };
    } catch (err: unknown) {
      const error = err as { stdout?: string; stderr?: string };
      const output = (error.stdout || error.stderr || 'Unknown compilation error').trim();
      const errors = output.split('\n').filter(l => l.includes('error TS'));
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
  async runTestExecution(workingDir: string): Promise<TestStageResult> {
    try {
      const { stdout } = await execAsync('npx vitest run --reporter=json 2>&1', {
        cwd: workingDir,
        timeout: 120000,
      });

      try {
        const jsonMatch = stdout.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
        if (jsonMatch) {
          const results = JSON.parse(jsonMatch[0]);
          const passed = results.numPassedTests || 0;
          const failed = results.numFailedTests || 0;
          const skipped = results.numPendingTests || 0;
          const total = passed + failed + skipped;

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
      // Exit code 1 usually means test failures
      if (error.code === 1) {
        const output = (error.stdout || error.stderr || '').trim();
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
      qgLog.warn('[QualityGates] Test execution error (non-fatal):', error);
      return {
        score: 100,
        passed: true,
        issues: [],
        suggestions: ['No test runner detected — consider adding tests'],
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
      };
    }
  }

  /**
   * Run a single AI review stage using the configured review model.
   */
  async runAIReview(
    stage: QualityGateStageName,
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
  ): Promise<QualityGateStageResult> {
    const promptTemplate = REVIEW_PROMPTS[stage];
    if (!promptTemplate) {
      return { score: 100, passed: true, issues: [], suggestions: [] };
    }

    const prompt = promptTemplate.replace('{taskDescription}', taskContext.taskDescription || 'No description provided');

    const userMessage = `Here is the code diff to review:\n\n\`\`\`diff\n${diff.slice(0, 50000)}\`\`\`\n\nTask: ${taskContext.taskDescription || 'No description'}`;

    try {
      const responseText = await this.callReviewModel(prompt, userMessage, config);

      // Parse the JSON response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        qgLog.warn(`[QualityGates] AI review "${stage}" returned non-JSON response`);
        return {
          score: 75,
          passed: true,
          issues: ['AI review returned an unexpected format — manual review recommended'],
          suggestions: [],
        };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 75));

      return {
        score,
        passed: score >= 70,
        issues: Array.isArray(parsed.issues) ? parsed.issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch (err) {
      qgLog.error(`[QualityGates] AI review "${stage}" failed:`, err);
      return {
        score: 80,
        passed: true,
        issues: [`AI review stage "${stage}" encountered an error`],
        suggestions: [],
      };
    }
  }

  /**
   * Call the review model (Kimi K2.5 by default, Anthropic Sonnet for escalation).
   */
  private async callReviewModel(
    systemPrompt: string,
    userMessage: string,
    config: QualityGateConfig,
  ): Promise<string> {
    if (config.reviewProvider === 'moonshot') {
      return this.callMoonshotApi(systemPrompt, userMessage, config.reviewModel);
    } else {
      return this.callAnthropicApi(systemPrompt, userMessage, config.reviewModel);
    }
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

    const response = await fetch('https://api.moonshot.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.1,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Moonshot API error (${response.status}): ${errorText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices[0]?.message?.content || '{}';
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
  ): QualityGateResult {
    const aggregateScore = computeAggregateScore(stages, config.stages);

    const result: QualityGateResult = {
      passed: false,
      aggregateScore,
      stages,
      cycleCount: 1,
      maxCycles: config.maxReviewCycles,
      reviewModel: config.reviewModel,
      reviewProvider: config.reviewProvider,
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
