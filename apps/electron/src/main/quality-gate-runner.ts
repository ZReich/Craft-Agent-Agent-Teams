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
import { runTypeCheckCached, runTestSuiteCached } from '@craft-agent/shared/agent-teams/local-checks';
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
  DesignArtifact,
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

  design_compliance: `You are a design fidelity reviewer checking that an approved UI design has been preserved during implementation.

A design variant was approved before coding began. The implementation MUST preserve:
1. **Visual structure** — Layout hierarchy, spacing, component arrangement must match the approved design
2. **Component usage** — The specific UI components from the design brief must be used (no swapping Button for a plain <button>, etc.)
3. **Animations and transitions** — All motion/animation code from the design must be preserved
4. **Responsive behavior** — Mobile/tablet breakpoints from the design must be intact
5. **Typography and color** — Font sizes, weights, and color tokens from the design must be used

The implementation MAY add:
- Data binding (connecting props to real data)
- Event handlers (click, submit, etc.)
- API integration
- State management

The implementation MUST NOT:
- Change the visual layout or component hierarchy
- Remove animations or transitions
- Swap components for different ones
- Alter the responsive breakpoints
- Change typography or color tokens

## Approved Design Context
{designContext}

Analyze the diff against the approved design. Return a JSON object:
{
  "score": <number 0-100>,
  "issues": [<string descriptions of design deviations>],
  "suggestions": [<string suggestions for preserving the design>]
}

Score guide: 95-100 = design fully preserved, 85-94 = minor deviations, 70-84 = notable changes, below 70 = design significantly altered.`,
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
  /** Optional design artifact — when present, enables design compliance review (REQ-011) */
  designArtifact?: DesignArtifact;
  /** Current review cycle count (for QG feedback messages) */
  cycleCount?: number;
}

interface ApiKeyProvider {
  getMoonshotApiKey(): Promise<string | null>;
  getAnthropicApiKey(): Promise<string | null>;
  getOpenAiConfig(): Promise<{ apiKey: string; baseUrl?: string | null } | null>;
}

type TestFailureKind = 'none' | 'no-tests' | 'test-failures' | 'infra-failure' | 'timeout' | 'config-error';
interface TestBaselineOptions {
  enabled: boolean;
  knownFailingTests: string[];
}

type AIReviewStage = 'architecture' | 'simplicity' | 'errors' | 'completeness';

interface ScopedDiff {
  stage: AIReviewStage;
  relevantHunks: string;
  fileCount: number;
  truncated: boolean;
}

interface ParsedDiffBlock {
  filePath: string;
  content: string;
  isNewFile: boolean;
  isBinary: boolean;
}

interface BypassContext {
  diffLineCount: number;
  fileCount: number;
  hasNewFiles: boolean;
  testsPassed: boolean;
  testCount: number;
  hasAsyncAwait: boolean;
  maxFunctionLinesInDiff: number;
}

interface DeterministicAnchor {
  score: number;
  summary: string;
}

const QUALITY_GATE_DEFAULTS = {
  stagePassScore: 70,
  stageDiffMaxChars: 50_000,
  deterministicAnchor: {
    minWeight: 0,
    maxWeight: 0.6,
    defaultWeight: 0.3,
    architecture: {
      sourceFilePenaltyHigh: { threshold: 8, points: 18 },
      sourceFilePenaltyMedium: { threshold: 5, points: 10 },
      newSourceFilePenalty: { threshold: 2, points: 12 },
      avgLinesPenaltyHigh: { threshold: 120, points: 18 },
      avgLinesPenaltyMedium: { threshold: 80, points: 10 },
      crossLayerPenalty: 8,
    },
    simplicity: {
      functionLinesPenaltyHigh: { threshold: 90, points: 28 },
      functionLinesPenaltyMedium: { threshold: 60, points: 16 },
      functionLinesPenaltyLow: { threshold: 40, points: 8 },
      branchPenaltyHigh: { threshold: 18, points: 18 },
      branchPenaltyMedium: { threshold: 10, points: 10 },
      changedLinesPenaltyHigh: { threshold: 180, points: 10 },
      changedLinesPenaltyMedium: { threshold: 100, points: 6 },
    },
    errors: {
      asyncWithoutTryCatchPenalty: 18,
      boundaryWithoutGuardsPenalty: 14,
      weakTestsPenalty: 12,
      largeDiffPenalty: { threshold: 140, points: 10 },
    },
  },
  bypass: {
    architecture: { maxDiffLines: 50, maxFilesChanged: 2, allowNewFiles: false, defaultScore: 90 },
    simplicity: { maxDiffLines: 100, maxFunctionLines: 50, defaultScore: 90 },
    errors: { maxDiffLines: 50, requirePassingTests: true, minTestCount: 1, disallowAsyncAwait: true, defaultScore: 90 },
  },
} as const;

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
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

  private createStageSkippedResult(reason: string, suggestions: string[] = []): QualityGateStageResult {
    return {
      score: 100,
      passed: true,
      issues: [],
      suggestions: [reason, ...suggestions],
    };
  }

  private shouldRequireTests(taskContext: TaskContext): boolean {
    if (taskContext.taskType === 'feature') return true;
    if (taskContext.taskType === 'docs' || taskContext.taskType === 'refactor' || taskContext.taskType === 'other') {
      return false;
    }

    // Heuristic fallback when taskType is absent.
    const desc = (taskContext.taskDescription || '').toLowerCase();
    const validationLike = /(validate|validation|typecheck|lint|audit|review|investigat|analyz|wiring|wire-up|diagnos|verify|check[- ]?in)/i.test(desc);
    if (validationLike) return false;

    // Keep strict-by-default for ambiguous work.
    return true;
  }

  private async hasReviewProviderAccess(reviewProvider: ReviewProvider): Promise<boolean> {
    if (reviewProvider === 'moonshot') {
      return Boolean(await this.apiKeyProvider.getMoonshotApiKey());
    }
    if (reviewProvider === 'openai') {
      const cfg = await this.apiKeyProvider.getOpenAiConfig();
      return Boolean(cfg?.apiKey);
    }
    return Boolean(await this.apiKeyProvider.getAnthropicApiKey());
  }

  private isModelCompatibleWithProvider(model: string, provider: ReviewProvider): boolean {
    const lower = model.toLowerCase();
    if (provider === 'moonshot') return lower.startsWith('kimi-');
    if (provider === 'openai') return lower.startsWith('gpt-') || lower.startsWith('openai/');
    return lower.startsWith('claude-') || lower.startsWith('anthropic/');
  }

  private getFallbackReviewModel(provider: ReviewProvider, preferredModel: string): string {
    if (this.isModelCompatibleWithProvider(preferredModel, provider)) {
      return preferredModel;
    }
    if (provider === 'moonshot') return 'kimi-k2.5';
    if (provider === 'openai') return 'gpt-5';
    return 'claude-sonnet-4-5-20250929';
  }

  private async resolveReviewExecutionConfig(
    preferredProvider: ReviewProvider,
    preferredModel: string,
  ): Promise<{ provider: ReviewProvider; model: string; warning?: string } | { error: string }> {
    if (await this.hasReviewProviderAccess(preferredProvider)) {
      return {
        provider: preferredProvider,
        model: this.getFallbackReviewModel(preferredProvider, preferredModel),
      };
    }

    const fallbackOrder: ReviewProvider[] = ['moonshot', 'anthropic', 'openai'];
    for (const candidate of fallbackOrder) {
      if (candidate === preferredProvider) continue;
      if (await this.hasReviewProviderAccess(candidate)) {
        const candidateModel = this.getFallbackReviewModel(candidate, preferredModel);
        return {
          provider: candidate,
          model: candidateModel,
          warning: `Preferred review provider "${preferredProvider}" is unavailable; falling back to "${candidate}" with model "${candidateModel}".`,
        };
      }
    }

    return { error: 'No review provider credentials are configured (Moonshot, Anthropic, or OpenAI).' };
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
    // AUDIT-FIX-5: Pre-slice diff once to avoid redundant 50KB string allocations per stage.
    // Previously each AI stage called diff.slice(0, 50000) independently (up to 7× per cycle).
    const truncatedDiff = diff.slice(0, 50000);
    const preferredReviewProvider = resolveReviewProvider(config.reviewModel, config.reviewProvider);
    let activeReviewProvider = preferredReviewProvider;
    let activeReviewModel = config.reviewModel;
    let resultConfig: QualityGateConfig = config;
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
      const testScope = config.testScope ?? 'affected';
      qgLog.info(`[QualityGates] Running test execution (scope: ${testScope})`);
      const requireTests = this.shouldRequireTests(taskContext);
      stages.tests = await this.runTestExecution(taskContext.workingDirectory, true, requireTests, {
        enabled: config.baselineAwareTests === true,
        knownFailingTests: config.knownFailingTests ?? [],
      }, testScope);
    }

    // Early exit if binary gates fail — no point running AI reviews
    if (config.stages.syntax.enabled && !stages.syntax.passed) {
      qgLog.info('[QualityGates] Syntax check failed, skipping AI reviews');
      return this.buildResult(stages, resultConfig, activeReviewProvider);
    }
    if (config.stages.tests.enabled && !stages.tests.passed) {
      qgLog.info('[QualityGates] Tests failed, skipping AI reviews');
      return this.buildResult(stages, resultConfig, activeReviewProvider);
    }

    // TDD enforcement: if enabled and task is a feature, check test-first discipline
    if (config.enforceTDD && taskContext.taskType === 'feature') {
      const tddPhase = taskContext.tddPhase || this.detectTDDPhase(diff);
      const tddResult = this.enforceTestFirst(diff, { ...taskContext, tddPhase });
      if (tddResult && !tddResult.passed) {
        qgLog.info('[QualityGates] TDD enforcement failed — no test files in diff');
        // Inject TDD failure into the completeness stage
        stages.completeness = tddResult;
        return this.buildResult(stages, resultConfig, activeReviewProvider);
      }
    }

    // Stages 3-6: AI Reviews
    // Implements REQ-NEXT-009 (diff scoping), REQ-NEXT-012 (batched call), REQ-NEXT-013 (tiered bypass)
    const aiStages: AIReviewStage[] = ['architecture', 'simplicity', 'errors', 'completeness'];
    const enabledAiStages = aiStages.filter(s => config.stages[s].enabled);
    let aiReviewUnavailable = false;
    let aiUnavailableReason: string | null = null;

    if (enabledAiStages.length > 0) {
      const executionConfig = await this.resolveReviewExecutionConfig(preferredReviewProvider, config.reviewModel);
      if ('error' in executionConfig) {
        qgLog.error('[QualityGates] Review provider preflight failed:', executionConfig.error);
        aiReviewUnavailable = true;
        aiUnavailableReason = executionConfig.error;
        for (const stage of enabledAiStages) {
          stages[stage] = this.createStageSkippedResult(
            executionConfig.error,
            ['Configure valid credentials for Moonshot, Anthropic, or OpenAI to enable AI review stages'],
          );
        }
      } else {
        activeReviewProvider = executionConfig.provider;
        activeReviewModel = executionConfig.model;
        resultConfig = { ...config, reviewModel: activeReviewModel, reviewProvider: activeReviewProvider };
        if (executionConfig.warning) {
          qgLog.warn(`[QualityGates] ${executionConfig.warning}`);
        }

        const scopedDiffs = new Map<AIReviewStage, ScopedDiff>();
        for (const stage of enabledAiStages) {
          scopedDiffs.set(stage, this.scopeDiffForStage(diff, stage));
        }

        const bypassContext = this.buildBypassContext(diff, stages.tests as TestStageResult);
        const stagesNeedingReview: AIReviewStage[] = [];
        for (const stage of enabledAiStages) {
          const bypassed = this.tryBypassStage(stage, bypassContext, resultConfig);
          if (bypassed) {
            stages[stage] = bypassed;
          } else {
            stagesNeedingReview.push(stage);
          }
        }

        if (stagesNeedingReview.length > 0) {
          const useCombinedReview = (resultConfig.useCombinedReview ?? true) && stagesNeedingReview.length > 1;
          if (useCombinedReview) {
            qgLog.info(`[QualityGates] Running ${stagesNeedingReview.length} AI stages via single combined review call`);
            const combinedResults = await this.runCombinedAIReview(
              stagesNeedingReview,
              scopedDiffs,
              taskContext,
              resultConfig,
              activeReviewProvider,
            );
            for (const stageName of stagesNeedingReview) {
              const stageResult = combinedResults[stageName];
              if (stageResult) {
                stages[stageName] = stageResult;
                continue;
              }

              // Graceful fallback for partial/failed combined parse (REQ-NEXT-012)
              const scoped = scopedDiffs.get(stageName);
              stages[stageName] = await this.runAIReview(
                stageName,
                scoped?.relevantHunks ?? truncatedDiff,
                taskContext,
                resultConfig,
                activeReviewProvider,
              );
            }
          } else {
            qgLog.info(`[QualityGates] Running ${stagesNeedingReview.length} AI review stages individually`);
            const aiResults = await Promise.allSettled(
              stagesNeedingReview.map((stage) => {
                const scoped = scopedDiffs.get(stage);
                return this.runAIReview(
                  stage,
                  scoped?.relevantHunks ?? truncatedDiff,
                  taskContext,
                  resultConfig,
                  activeReviewProvider,
                );
              }),
            );

            for (let i = 0; i < stagesNeedingReview.length; i++) {
              const stageName = stagesNeedingReview[i];
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
        }
      }
    }

    // SDD stages: run only when a spec is provided (backward-compatible by default)
    if (activeSpec && activeSpec.requirements.length > 0) {
      qgLog.info('[QualityGates] Running SDD review stages');

      if (aiReviewUnavailable) {
        const reason = aiUnavailableReason ?? 'AI review stages unavailable due to missing provider credentials';
        if (config.stages.spec_compliance.enabled) {
          stages.spec_compliance = this.createStageSkippedResult(
            reason,
            ['Configure review model credentials to run spec compliance checks'],
          );
        }
        if (config.stages.traceability.enabled) {
          stages.traceability = this.createStageSkippedResult(
            reason,
            ['Configure review model credentials to run traceability checks'],
          );
        }
        if (config.stages.rollout_safety.enabled) {
          stages.rollout_safety = this.createStageSkippedResult(
            reason,
            ['Configure review model credentials to run rollout safety checks'],
          );
        }
        return this.buildResult(stages, resultConfig, activeReviewProvider);
      }

      // AUDIT-FIX-5: Run SDD stages in parallel (they are independent of each other)
      const shouldRunRolloutSafety =
        config.stages.rollout_safety.enabled &&
        Boolean(activeSpec.rolloutPlan || activeSpec.rollbackPlan || activeSpec.observabilityPlan);

      type SDDStageEntry = { name: string; promise: Promise<QualityGateStageResult> };
      const sddTasks: SDDStageEntry[] = [];

      if (config.stages.spec_compliance.enabled) {
        sddTasks.push({ name: 'spec_compliance', promise: this.runSpecComplianceReview(truncatedDiff, taskContext, activeSpec, resultConfig, activeReviewProvider) });
      }
      if (config.stages.traceability.enabled) {
        sddTasks.push({ name: 'traceability', promise: this.runTraceabilityReview(truncatedDiff, taskContext, activeSpec, resultConfig, activeReviewProvider) });
      }
      if (shouldRunRolloutSafety) {
        sddTasks.push({ name: 'rollout_safety', promise: this.runRolloutSafetyReview(truncatedDiff, taskContext, activeSpec, resultConfig, activeReviewProvider) });
      }

      if (sddTasks.length > 0) {
        qgLog.info(`[QualityGates] Running ${sddTasks.length} SDD stages in parallel`);
        const sddResults = await Promise.allSettled(sddTasks.map(t => t.promise));
        for (let i = 0; i < sddTasks.length; i++) {
          const result = sddResults[i];
          const stageName = sddTasks[i].name as keyof typeof stages;
          if (result.status === 'fulfilled') {
            (stages as Record<string, QualityGateStageResult>)[stageName] = result.value;
          } else {
            const errorDetails = this.serializeError(result.reason);
            qgLog.error(`[QualityGates] SDD stage "${stageName}" failed:`, errorDetails);
            (stages as Record<string, QualityGateStageResult>)[stageName] = this.createStageFailureResult(
              `SDD stage "${stageName}" failed: ${errorDetails.message}`,
              ['Fix model/provider credentials or endpoint configuration, then rerun quality gates'],
            );
          }
        }
      }
    } else {
      qgLog.info('[QualityGates] No spec provided; skipping SDD review stages');
    }

    // Design compliance stage: run only when a design artifact is attached (REQ-011)
    if (taskContext.designArtifact && config.stages.design_compliance.enabled) {
      if (aiReviewUnavailable) {
        stages.design_compliance = this.createStageSkippedResult(
          aiUnavailableReason ?? 'AI review stages unavailable',
          ['Configure review model credentials to run design compliance checks'],
        );
      } else {
        qgLog.info('[QualityGates] Running design compliance review');
        stages.design_compliance = await this.runDesignComplianceReview(
          truncatedDiff, taskContext, resultConfig, activeReviewProvider,
        );
      }
    }

    return this.buildResult(stages, resultConfig, activeReviewProvider);
  }

  /**
   * Progressive pipeline entrypoint.
   * Keeps compatibility with callers that explicitly request progressive mode.
   *
   * The underlying runPipeline already executes progressively:
   * - syntax/tests first
   * - early return on binary failures
   * - AI stages only when binary gates pass
   */
  async runProgressive(
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
    spec?: Pick<Spec, 'requirements' | 'rolloutPlan' | 'rollbackPlan' | 'observabilityPlan'>,
  ): Promise<QualityGateResult> {
    return this.runPipeline(diff, taskContext, config, spec);
  }

  /**
   * Run TypeScript compilation check.
   */
  async runSyntaxCheck(workingDir: string, allowInstall = true): Promise<QualityGateStageResult> {
    const result = await runTypeCheckCached({
      workingDir,
      timeoutMs: 60000,
      cacheKey: `quality:${workingDir}:typecheck`,
      forceRefresh: !allowInstall,
    });

    if (result.passed) {
      return { score: 100, passed: true, issues: [], suggestions: [] };
    }

    const output = this.normalizeOutput(result.rawOutput || result.errors.join('\n') || 'Unknown compilation error');
    if (this.isInfraTypeFailure(output) && allowInstall) {
      const installed = await this.ensureDependenciesInstalled(workingDir);
      if (installed) {
        return this.runSyntaxCheck(workingDir, false);
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

    return {
      score: 0,
      passed: false,
      issues: errors.length > 0 ? errors.slice(0, 20) : [output.slice(0, 500)],
      suggestions: ['Fix all TypeScript compilation errors before proceeding'],
    };
  }

  /**
   * Run test suite and parse results.
   *
   * @param testScope 'affected' runs only tests for changed files (vitest --changed),
   *   'full' runs the entire suite, 'none' skips tests entirely. Default: 'full'.
   */
  async runTestExecution(
    workingDir: string,
    allowInstall = true,
    requireTests = true,
    baselineOptions: TestBaselineOptions = { enabled: false, knownFailingTests: [] },
    testScope: 'full' | 'affected' | 'none' = 'full',
  ): Promise<TestStageResult> {
    // Implements testScope='none': skip tests entirely
    if (testScope === 'none') {
      return {
        score: 100,
        passed: true,
        issues: [],
        suggestions: ['Tests skipped (testScope: none)'],
        totalTests: 0,
        passedTests: 0,
        failedTests: 0,
        skippedTests: 0,
      };
    }

    const changedOnly = testScope === 'affected';
    const timeoutMs = 120000;
    const maxAttempts = 2;
    const cacheKey = `quality:${workingDir}:tests`;
    const attempts: Array<{ kind: TestFailureKind; details: string }> = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const forceRefresh = attempt > 1;
      try {
        const result = await runTestSuiteCached({
          workingDir,
          timeoutMs,
          cacheKey,
          forceRefresh,
          changedOnly,
        });

        const output = this.normalizeOutput(result.rawOutput || '');
        const diagnostics = this.formatTestDiagnostics(
          result.metadata?.command ?? 'bun run vitest run --reporter=json -c vitest.config.ts',
          workingDir,
          timeoutMs,
          attempt,
          maxAttempts,
          Boolean(result.metadata?.cacheHit),
        );

        if (result.total === 0) {
          // Implements REQ-QG-001: Feature tasks must have tests even in affected scope
          if (!requireTests) {
            return {
              score: 100,
              passed: true,
              issues: [],
              suggestions: [
                changedOnly
                  ? 'No tests affected by the changed files; tests not required for this task type'
                  : 'No test files detected; tests are not required for this task type',
                diagnostics,
              ],
              totalTests: 0,
              passedTests: 0,
              failedTests: 0,
              skippedTests: 0,
            };
          }

          return {
            score: 0,
            passed: false,
            issues: [
              'No test files found for changed files — feature tasks require tests',
              diagnostics,
            ],
            suggestions: [
              'Write tests covering the new behavior using .test.ts or .spec.ts files',
              'Use the test-writer skill to generate tests from your requirement IDs',
            ],
            totalTests: 0,
            passedTests: 0,
            failedTests: 0,
            skippedTests: 0,
          };
        }

        const kind = this.classifyTestFailure(result, output);
        if (kind !== 'none') {
          attempts.push({ kind, details: diagnostics });
        }

        if (kind === 'infra-failure' && allowInstall && attempt === 1) {
          const installed = await this.ensureDependenciesInstalled(workingDir);
          if (installed) {
            continue;
          }
        }

        if ((kind === 'infra-failure' || kind === 'timeout' || kind === 'test-failures') && attempt < maxAttempts) {
          qgLog.warn(`[QualityGates] Test stage failed (${kind}) on attempt ${attempt}; retrying once with cache bypass`);
          continue;
        }

        if (kind === 'none') {
          const warnings = attempts.length > 0
            ? ['Flaky test behavior detected: initial attempt failed but retry passed', ...attempts.map(a => a.details)]
            : [];
          return {
            score: 100,
            passed: true,
            issues: [],
            suggestions: warnings,
            totalTests: result.total,
            passedTests: result.passed_count,
            failedTests: result.failed,
            skippedTests: result.skipped,
          };
        }

        if (
          kind === 'test-failures'
          && baselineOptions.enabled
          && this.isBaselineOnlyFailure(result.failedTests, baselineOptions.knownFailingTests)
        ) {
          return {
            score: 100,
            passed: true,
            issues: [],
            suggestions: [
              'Test failures match known baseline failures; blocking suppressed by baseline-aware mode',
              diagnostics,
            ],
            totalTests: result.total,
            passedTests: result.passed_count,
            failedTests: result.failed,
            skippedTests: result.skipped,
          };
        }

        return {
          score: 0,
          passed: false,
          issues: [
            ...result.failedTests.slice(0, 10).map(name => `FAIL: ${name}`),
            diagnostics,
            ...attempts
              .filter(a => a.details !== diagnostics)
              .map(a => `Previous attempt (${a.kind}): ${a.details}`),
          ],
          suggestions: this.testFailureSuggestions(kind),
          totalTests: result.total,
          passedTests: result.passed_count,
          failedTests: result.failed,
          skippedTests: result.skipped,
        };
      } catch (err: unknown) {
        const error = err as { stdout?: string; stderr?: string; code?: number };
        const output = this.normalizeOutput(error.stdout || error.stderr || '');
        const fallbackCommand = changedOnly
          ? 'bun run vitest run --reporter=json -c vitest.config.ts --changed'
          : 'bun run vitest run --reporter=json -c vitest.config.ts';
        const diagnostics = this.formatTestDiagnostics(
          fallbackCommand,
          workingDir,
          timeoutMs,
          attempt,
          maxAttempts,
          false,
        );

        if (this.isMissingVitest(output) && allowInstall && attempt === 1) {
          const installed = await this.ensureDependenciesInstalled(workingDir);
          if (installed) {
            continue;
          }
        }

        const kind: TestFailureKind = this.isTimeoutFailure(output)
          ? 'timeout'
          : this.isInfraTestFailure(output)
            ? 'infra-failure'
            : error.code === 1
              ? 'test-failures'
              : 'config-error';
        attempts.push({ kind, details: diagnostics });

        if ((kind === 'infra-failure' || kind === 'timeout' || kind === 'test-failures') && attempt < maxAttempts) {
          qgLog.warn(`[QualityGates] Test execution error (${kind}) on attempt ${attempt}; retrying once`);
          continue;
        }

        const outputSnippet = output ? output.slice(0, 500) : 'No error output captured';
        return {
          score: 0,
          passed: false,
          issues: [
            `Test execution failed (${kind})`,
            outputSnippet,
            diagnostics,
            ...attempts
              .filter(a => a.details !== diagnostics)
              .map(a => `Previous attempt (${a.kind}): ${a.details}`),
          ],
          suggestions: this.testFailureSuggestions(kind),
          totalTests: 0,
          passedTests: 0,
          failedTests: 1,
          skippedTests: 0,
        };
      }
    }

    return {
      score: 0,
      passed: false,
      issues: ['Test stage exhausted retry attempts'],
      suggestions: ['Re-run tests manually and inspect infrastructure/tooling state'],
      totalTests: 0,
      passedTests: 0,
      failedTests: 1,
      skippedTests: 0,
    };
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

  private isTimeoutFailure(output: string): boolean {
    return /(timed out|timeout|exceeded.*time limit)/i.test(output);
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

  private classifyTestFailure(result: { failed: number; rawOutput: string }, normalizedOutput: string): TestFailureKind {
    if (result.failed === 0) return 'none';
    if (this.isTimeoutFailure(normalizedOutput)) return 'timeout';
    if (this.isInfraTestFailure(normalizedOutput)) return 'infra-failure';
    if (/vitest\.config|configuration|config file|cannot parse/i.test(normalizedOutput)) return 'config-error';
    return 'test-failures';
  }

  private formatTestDiagnostics(
    command: string,
    cwd: string,
    timeoutMs: number,
    attempt: number,
    maxAttempts: number,
    cacheHit: boolean,
  ): string {
    return `Diagnostics: command="${command}", cwd="${cwd}", timeoutMs=${timeoutMs}, attempt=${attempt}/${maxAttempts}, cacheHit=${cacheHit}`;
  }

  // Implements REQ-QG-003: Include test-writer skill guidance in failure feedback
  private testFailureSuggestions(kind: TestFailureKind): string[] {
    if (kind === 'no-tests') return ['Add unit tests for this change and re-run the quality gate', 'Use the test-writer skill to generate tests from your requirement IDs'];
    if (kind === 'infra-failure') return ['Resolve dependency/tooling errors (install deps, verify workspace setup) and rerun tests'];
    if (kind === 'timeout') return ['Investigate long-running tests, reduce test scope, or optimize setup before retrying'];
    if (kind === 'config-error') return ['Fix vitest configuration issues and rerun tests'];
    return ['Fix all failing tests and rerun the quality gate', 'Use the test-writer skill to generate or fix failing tests'];
  }

  private isBaselineOnlyFailure(failedTests: string[], knownFailingTests: string[]): boolean {
    if (!failedTests.length || !knownFailingTests.length) return false;
    const baselineSet = new Set(knownFailingTests.map((n) => n.trim()).filter(Boolean));
    if (baselineSet.size === 0) return false;
    return failedTests.every((failed) => baselineSet.has(failed.trim()));
  }

  private async ensureDependenciesInstalled(workingDir: string): Promise<boolean> {
    try {
      qgLog.info('[QualityGates] Installing dependencies (bun install)');
      await execAsync('bun install', {
        cwd: workingDir,
        timeout: 60000,
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

    const userMessage = `Here is the code diff to review:\n\n\`\`\`diff\n${diff}\`\`\`\n\nTask: ${taskContext.taskDescription || 'No description'}`;

    try {
      const responseText = await this.callReviewModel(prompt, userMessage, config, reviewProvider);

      const parsed = this.parseAiReviewResponse(responseText);
      if (!parsed) {
        qgLog.warn(`[QualityGates] AI review "${stage}" returned non-JSON response`);
        return this.createStageSkippedResult(
          `AI review "${stage}" returned unstructured output and was treated as advisory`,
          ['Prefer a review model/provider that reliably returns JSON for stricter gate enforcement'],
        );
      }
      let score = Math.max(0, Math.min(100, Number(parsed.score) || 100));

      // Completeness stage: enforce integration verification auto-fail
      // Implements REQ-006: Fail when new code is not integrated
      if (stage === 'completeness' && parsed.integrationVerified === false) {
        score = Math.min(score, 65); // Cap below passing threshold
        const integrationIssue = 'INTEGRATION FAILURE: New code is not connected to existing code — components, functions, or handlers are dead code';
        const issues = parsed.issues;
        if (!issues.some((i: string) => i.includes('INTEGRATION FAILURE'))) {
          issues.unshift(integrationIssue);
        }
        return {
          score,
          passed: false,
          issues,
          suggestions: parsed.suggestions,
        };
      }

      return {
        ...this.applyDeterministicAnchor(
          stage as AIReviewStage,
          {
            score,
            passed: score >= QUALITY_GATE_DEFAULTS.stagePassScore,
            issues: parsed.issues,
            suggestions: parsed.suggestions,
          },
          diff,
          config,
        ),
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

  private splitDiffBlocks(fullDiff: string): ParsedDiffBlock[] {
    const blocks = fullDiff.split(/(?=^diff --git )/m).filter(Boolean);
    const parsed: ParsedDiffBlock[] = [];

    for (const block of blocks) {
      const pathMatch = block.match(/^diff --git a\/(.+?) b\/(.+)$/m);
      if (!pathMatch) continue;

      const filePath = (pathMatch[2] || pathMatch[1] || '').trim();
      if (!filePath) continue;

      parsed.push({
        filePath,
        content: block,
        isNewFile: /(^|\n)new file mode\s+/m.test(block) || /(^|\n)--- \/dev\/null(\n|$)/m.test(block),
        isBinary: /(^|\n)Binary files .* differ(\n|$)/m.test(block),
      });
    }

    return parsed;
  }

  private isTestFile(filePath: string): boolean {
    return /(^|\/)(__tests__|tests)\//i.test(filePath) || /\.(test|spec)\.[jt]sx?$/i.test(filePath);
  }

  private isConfigFile(filePath: string): boolean {
    return /(^|\/)(tsconfig|package\.json|bunfig|vitest\.config|vite\.config|jest\.config|eslint|prettier|webpack|rollup|turbo|nx|biome|commitlint|pnpm-workspace|\.env)/i.test(filePath)
      || /\.(ya?ml|toml|ini|conf)$/i.test(filePath);
  }

  private isStyleFile(filePath: string): boolean {
    return /\.(css|scss|sass|less|styl)$/i.test(filePath);
  }

  private isSourceFile(filePath: string): boolean {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(filePath);
  }

  private isTypeDefinitionFile(filePath: string): boolean {
    return /\.d\.ts$/i.test(filePath);
  }

  private isLockFile(filePath: string): boolean {
    return /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock)$/i.test(filePath);
  }

  private isApiBoundaryFile(filePath: string): boolean {
    return /(api|route|routes|controller|handler|middleware|server|client|http|request|response|rpc|service)/i.test(filePath);
  }

  private scopeDiffForStage(fullDiff: string, stage: AIReviewStage): ScopedDiff {
    const blocks = this.splitDiffBlocks(fullDiff);
    const selected = blocks.filter((block) => {
      const { filePath } = block;

      if (stage === 'architecture') {
        return this.isSourceFile(filePath) && !this.isTestFile(filePath) && !this.isConfigFile(filePath) && !this.isStyleFile(filePath);
      }

      if (stage === 'simplicity') {
        return this.isSourceFile(filePath)
          && !this.isTypeDefinitionFile(filePath)
          && !this.isTestFile(filePath)
          && !this.isConfigFile(filePath);
      }

      if (stage === 'errors') {
        if (this.isTestFile(filePath) || this.isStyleFile(filePath)) return false;
        return this.isSourceFile(filePath) || this.isApiBoundaryFile(filePath);
      }

      // completeness: everything except binary + lockfiles
      return !block.isBinary && !this.isLockFile(filePath);
    });

    let scoped = selected.map((block) => block.content).join('\n');
    if (!scoped.trim()) {
      scoped = '[No stage-relevant hunks after diff scoping]';
    }

    const truncated = scoped.length > QUALITY_GATE_DEFAULTS.stageDiffMaxChars;
    if (truncated) {
      scoped = `${scoped.slice(0, QUALITY_GATE_DEFAULTS.stageDiffMaxChars)}\n\n[... scoped diff truncated at ${QUALITY_GATE_DEFAULTS.stageDiffMaxChars} characters ...]`;
    }

    return {
      stage,
      relevantHunks: scoped,
      fileCount: selected.length,
      truncated,
    };
  }

  private countChangedLines(diff: string): number {
    return diff
      .split(/\r?\n/)
      .filter((line) => (line.startsWith('+') || line.startsWith('-')) && !line.startsWith('+++') && !line.startsWith('---'))
      .length;
  }

  private estimateMaxFunctionLinesInDiff(diff: string): number {
    const addedLines = diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1));

    // Heuristic only: estimate contiguous added function spans without brace parsing.
    // This avoids brittle brace counting across comments/template literals.
    const functionStartPattern = /(?:\basync\s+)?\bfunction\b|\b=>\s*\{|\b(class|constructor)\b|^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:async\s*)?\(/;
    const declarationBoundaryPattern = /^(?:export\s+)?(?:const|let|var|class|function|type|interface)\b/;
    const getIndent = (line: string): number => (line.match(/^\s*/)?.[0].replace(/\t/g, '  ').length ?? 0);

    let maxLines = 0;

    for (let i = 0; i < addedLines.length; i++) {
      const startLine = addedLines[i];
      if (!functionStartPattern.test(startLine)) continue;

      const startIndent = getIndent(startLine);
      let span = 1;

      for (let j = i + 1; j < addedLines.length; j++) {
        const line = addedLines[j];
        const trimmed = line.trim();

        if (!trimmed) {
          span += 1;
          continue;
        }

        const indent = getIndent(line);
        const startsNextFunction = functionStartPattern.test(line) && indent <= startIndent;
        const startsNextDeclaration = declarationBoundaryPattern.test(trimmed) && indent <= startIndent;
        if (startsNextFunction || startsNextDeclaration) break;

        span += 1;
      }

      maxLines = Math.max(maxLines, span);
    }

    return maxLines;
  }

  private buildBypassContext(diff: string, testsStage: TestStageResult): BypassContext {
    const blocks = this.splitDiffBlocks(diff);
    const addedLines = diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');

    return {
      diffLineCount: this.countChangedLines(diff),
      fileCount: blocks.length,
      hasNewFiles: blocks.some((block) => block.isNewFile),
      testsPassed: Boolean(testsStage?.passed),
      testCount: Number(testsStage?.totalTests ?? 0),
      hasAsyncAwait: /\basync\b|\bawait\b/.test(addedLines),
      maxFunctionLinesInDiff: this.estimateMaxFunctionLinesInDiff(diff),
    };
  }

  /**
   * Implements REQ-NEXT-003: blend deterministic anchors with LLM stage scoring.
   */
  private applyDeterministicAnchor(
    stage: AIReviewStage,
    stageResult: QualityGateStageResult,
    diff: string,
    config: QualityGateConfig,
    testsStage?: TestStageResult,
  ): QualityGateStageResult {
    if (!config.deterministicAnchors?.enabled) return stageResult;
    if (stage !== 'architecture' && stage !== 'simplicity' && stage !== 'errors') return stageResult;

    const anchor = this.computeDeterministicAnchor(stage, diff, testsStage);
    if (!anchor) return stageResult;

    const weight = Math.min(
      QUALITY_GATE_DEFAULTS.deterministicAnchor.maxWeight,
      Math.max(
        QUALITY_GATE_DEFAULTS.deterministicAnchor.minWeight,
        config.deterministicAnchors.weight ?? QUALITY_GATE_DEFAULTS.deterministicAnchor.defaultWeight,
      ),
    );
    const blendedScore = Math.round(stageResult.score * (1 - weight) + anchor.score * weight);

    return {
      ...stageResult,
      score: blendedScore,
      passed: blendedScore >= QUALITY_GATE_DEFAULTS.stagePassScore,
      suggestions: [
        ...stageResult.suggestions,
        `Deterministic anchor (${stage}): ${anchor.score}/100 — ${anchor.summary}`,
      ],
    };
  }

  private computeDeterministicAnchor(
    stage: AIReviewStage,
    diff: string,
    testsStage?: TestStageResult,
  ): DeterministicAnchor | null {
    const changedLines = this.countChangedLines(diff);
    const blocks = this.splitDiffBlocks(diff);
    const addedText = diff
      .split(/\r?\n/)
      .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
      .map((line) => line.slice(1))
      .join('\n');

    if (stage === 'architecture') {
      const sourceBlocks = blocks.filter((block) =>
        this.isSourceFile(block.filePath) && !this.isTestFile(block.filePath) && !this.isConfigFile(block.filePath) && !this.isStyleFile(block.filePath),
      );
      const sourceCount = Math.max(1, sourceBlocks.length);
      const newSourceCount = sourceBlocks.filter((block) => block.isNewFile).length;
      const avgLinesPerFile = changedLines / sourceCount;
      const hasCrossLayerTouch =
        sourceBlocks.some((b) => /renderer|components|ui\//i.test(b.filePath)) &&
        sourceBlocks.some((b) => /main|server|api|service/i.test(b.filePath));

      let score = 100;
      const architectureRules = QUALITY_GATE_DEFAULTS.deterministicAnchor.architecture;
      if (sourceCount > architectureRules.sourceFilePenaltyHigh.threshold) score -= architectureRules.sourceFilePenaltyHigh.points;
      else if (sourceCount > architectureRules.sourceFilePenaltyMedium.threshold) score -= architectureRules.sourceFilePenaltyMedium.points;
      if (newSourceCount > architectureRules.newSourceFilePenalty.threshold) score -= architectureRules.newSourceFilePenalty.points;
      if (avgLinesPerFile > architectureRules.avgLinesPenaltyHigh.threshold) score -= architectureRules.avgLinesPenaltyHigh.points;
      else if (avgLinesPerFile > architectureRules.avgLinesPenaltyMedium.threshold) score -= architectureRules.avgLinesPenaltyMedium.points;
      if (hasCrossLayerTouch) score -= architectureRules.crossLayerPenalty;

      score = clampScore(score);
      return {
        score,
        summary: `files=${sourceCount}, newFiles=${newSourceCount}, avgLinesPerFile=${Math.round(avgLinesPerFile)}, crossLayer=${hasCrossLayerTouch}`,
      };
    }

    if (stage === 'simplicity') {
      const maxFunctionLines = this.estimateMaxFunctionLinesInDiff(diff);
      const branchCount = (addedText.match(/\b(if|else if|switch|case|for|while|catch)\b/g) || []).length;
      let score = 100;
      const simplicityRules = QUALITY_GATE_DEFAULTS.deterministicAnchor.simplicity;
      if (maxFunctionLines > simplicityRules.functionLinesPenaltyHigh.threshold) score -= simplicityRules.functionLinesPenaltyHigh.points;
      else if (maxFunctionLines > simplicityRules.functionLinesPenaltyMedium.threshold) score -= simplicityRules.functionLinesPenaltyMedium.points;
      else if (maxFunctionLines > simplicityRules.functionLinesPenaltyLow.threshold) score -= simplicityRules.functionLinesPenaltyLow.points;
      if (branchCount > simplicityRules.branchPenaltyHigh.threshold) score -= simplicityRules.branchPenaltyHigh.points;
      else if (branchCount > simplicityRules.branchPenaltyMedium.threshold) score -= simplicityRules.branchPenaltyMedium.points;
      if (changedLines > simplicityRules.changedLinesPenaltyHigh.threshold) score -= simplicityRules.changedLinesPenaltyHigh.points;
      else if (changedLines > simplicityRules.changedLinesPenaltyMedium.threshold) score -= simplicityRules.changedLinesPenaltyMedium.points;
      score = clampScore(score);
      return {
        score,
        summary: `maxFunctionLines=${maxFunctionLines}, branchOps=${branchCount}, changedLines=${changedLines}`,
      };
    }

    if (stage === 'errors') {
      const hasBoundaryFiles = blocks.some((block) => this.isApiBoundaryFile(block.filePath));
      const hasAsyncAwait = /\basync\b|\bawait\b/.test(addedText);
      const hasTryCatch = /\btry\s*\{|\bcatch\s*\(/.test(addedText);
      const hasGuarding = /\bif\s*\(|\?\?|\?\./.test(addedText);
      const testsHealthy = testsStage ? testsStage.passed && testsStage.totalTests > 0 : true;

      let score = 100;
      const errorRules = QUALITY_GATE_DEFAULTS.deterministicAnchor.errors;
      if (hasAsyncAwait && !hasTryCatch) score -= errorRules.asyncWithoutTryCatchPenalty;
      if (hasBoundaryFiles && !hasGuarding) score -= errorRules.boundaryWithoutGuardsPenalty;
      if (!testsHealthy) score -= errorRules.weakTestsPenalty;
      if (changedLines > errorRules.largeDiffPenalty.threshold) score -= errorRules.largeDiffPenalty.points;
      score = clampScore(score);

      return {
        score,
        summary: `async=${hasAsyncAwait}, tryCatch=${hasTryCatch}, boundaryFiles=${hasBoundaryFiles}, guarding=${hasGuarding}, testsHealthy=${testsHealthy}`,
      };
    }

    return null;
  }

  private createBypassedStageResult(stage: AIReviewStage, score: number, reason: string): QualityGateStageResult {
    return {
      score,
      passed: score >= QUALITY_GATE_DEFAULTS.stagePassScore,
      issues: [],
      suggestions: [`Bypassed — low-risk change (${stage}): ${reason}`],
    };
  }

  private tryBypassStage(
    stage: AIReviewStage,
    context: BypassContext,
    config: QualityGateConfig,
  ): QualityGateStageResult | null {
    if (stage === 'completeness') return null; // REQ-NEXT-013: completeness is never bypassed

    const bypass = config.bypass;
    if (!bypass?.enabled) return null;

    if (stage === 'architecture') {
      const maxDiffLines = bypass.architecture?.maxDiffLines ?? QUALITY_GATE_DEFAULTS.bypass.architecture.maxDiffLines;
      const maxFilesChanged = bypass.architecture?.maxFilesChanged ?? QUALITY_GATE_DEFAULTS.bypass.architecture.maxFilesChanged;
      const allowNewFiles = bypass.architecture?.allowNewFiles ?? QUALITY_GATE_DEFAULTS.bypass.architecture.allowNewFiles;
      const defaultScore = bypass.architecture?.defaultScore ?? QUALITY_GATE_DEFAULTS.bypass.architecture.defaultScore;

      if (
        context.diffLineCount <= maxDiffLines
        && context.fileCount <= maxFilesChanged
        && (allowNewFiles || !context.hasNewFiles)
      ) {
        return this.createBypassedStageResult(stage, defaultScore, `≤${maxDiffLines} changed lines, ≤${maxFilesChanged} files, no risky architecture churn`);
      }
      return null;
    }

    if (stage === 'simplicity') {
      const maxDiffLines = bypass.simplicity?.maxDiffLines ?? QUALITY_GATE_DEFAULTS.bypass.simplicity.maxDiffLines;
      const maxFunctionLines = bypass.simplicity?.maxFunctionLines ?? QUALITY_GATE_DEFAULTS.bypass.simplicity.maxFunctionLines;
      const defaultScore = bypass.simplicity?.defaultScore ?? QUALITY_GATE_DEFAULTS.bypass.simplicity.defaultScore;

      if (
        context.diffLineCount <= maxDiffLines
        && context.maxFunctionLinesInDiff <= maxFunctionLines
      ) {
        return this.createBypassedStageResult(stage, defaultScore, `≤${maxDiffLines} changed lines and no detected function > ${maxFunctionLines} added lines`);
      }
      return null;
    }

    if (stage === 'errors') {
      const maxDiffLines = bypass.errors?.maxDiffLines ?? QUALITY_GATE_DEFAULTS.bypass.errors.maxDiffLines;
      const requirePassingTests = bypass.errors?.requirePassingTests ?? QUALITY_GATE_DEFAULTS.bypass.errors.requirePassingTests;
      const minTestCount = bypass.errors?.minTestCount ?? QUALITY_GATE_DEFAULTS.bypass.errors.minTestCount;
      const disallowAsyncAwait = bypass.errors?.disallowAsyncAwait ?? QUALITY_GATE_DEFAULTS.bypass.errors.disallowAsyncAwait;
      const defaultScore = bypass.errors?.defaultScore ?? QUALITY_GATE_DEFAULTS.bypass.errors.defaultScore;

      const testsOk = !requirePassingTests || (context.testsPassed && context.testCount >= minTestCount);
      const asyncOk = !disallowAsyncAwait || !context.hasAsyncAwait;

      if (context.diffLineCount <= maxDiffLines && testsOk && asyncOk) {
        return this.createBypassedStageResult(stage, defaultScore, `≤${maxDiffLines} changed lines with strong deterministic safety signals`);
      }
    }

    return null;
  }

  private normalizeCombinedStageResult(
    stage: AIReviewStage,
    payload: Record<string, unknown>,
  ): QualityGateStageResult | null {
    const score = Math.max(0, Math.min(100, Number(payload.score)));
    if (!Number.isFinite(score)) return null;

    const issues = Array.isArray(payload.issues)
      ? payload.issues.filter((issue): issue is string => typeof issue === 'string')
      : [];
    const suggestions = Array.isArray(payload.suggestions)
      ? payload.suggestions.filter((suggestion): suggestion is string => typeof suggestion === 'string')
      : [];

    if (stage === 'completeness' && payload.integrationVerified === false) {
      const capped = Math.min(score, 65);
      const integrationIssue = 'INTEGRATION FAILURE: New code is not connected to existing code — components, functions, or handlers are dead code';
      return {
        score: capped,
        passed: false,
        issues: issues.some((issue) => issue.includes('INTEGRATION FAILURE'))
          ? issues
          : [integrationIssue, ...issues],
        suggestions,
      };
    }

    return {
      score,
      passed: score >= QUALITY_GATE_DEFAULTS.stagePassScore,
      issues,
      suggestions,
    };
  }

  private async runCombinedAIReview(
    stagesToReview: AIReviewStage[],
    scopedDiffs: Map<AIReviewStage, ScopedDiff>,
    taskContext: TaskContext,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<Partial<Record<AIReviewStage, QualityGateStageResult>>> {
    const stageInstructions = stagesToReview.map((stage) => {
      const title = stage === 'errors'
        ? 'Error Analysis'
        : stage.charAt(0).toUpperCase() + stage.slice(1);
      const scoped = scopedDiffs.get(stage);
      const stageDiff = scoped?.relevantHunks ?? '[Missing scoped diff]';

      let rubric = '';
      if (stage === 'architecture') {
        rubric = '- Evaluate module boundaries, coupling, and separation of concerns.';
      } else if (stage === 'simplicity') {
        rubric = '- Evaluate readability, complexity, and avoidable abstraction.';
      } else if (stage === 'errors') {
        rubric = '- Evaluate runtime risk, missing guards, and boundary error handling.';
      } else {
        rubric = '- Evaluate end-to-end completeness and whether new code is integrated and wired.';
      }

      return `## ${title}
${rubric}
Scoped diff:
\`\`\`diff
${stageDiff}
\`\`\``;
    }).join('\n\n');

    const requiredShape = stagesToReview
      .map((stage) => {
        if (stage === 'completeness') {
          return `"${stage}": { "score": <0-100>, "integrationVerified": <boolean>, "issues": [<string>], "suggestions": [<string>] }`;
        }
        return `"${stage}": { "score": <0-100>, "issues": [<string>], "suggestions": [<string>] }`;
      })
      .join(',\n  ');

    const systemPrompt = `You are a senior code reviewer.
Review the staged scoped diffs below and return JSON only.

Return an object with EXACTLY these stage keys:
{
  ${requiredShape}
}

Scoring rubric:
- 95-100 excellent
- 85-94 good
- 70-84 needs work
- below 70 failing
- For completeness: if integration is not verified, integrationVerified MUST be false and score must be below 70.`;

    const userMessage = `Task: ${taskContext.taskDescription || 'No task description provided'}

${stageInstructions}`;

    const result: Partial<Record<AIReviewStage, QualityGateStageResult>> = {};

    try {
      const responseText = await this.callReviewModel(systemPrompt, userMessage, config, reviewProvider);
      const parsed = this.parseJsonObject(responseText);
      if (!parsed) {
        qgLog.warn('[QualityGates] Combined AI review returned non-JSON output; falling back to per-stage calls');
        return result;
      }

      for (const stage of stagesToReview) {
        const raw = parsed[stage];
        if (!raw || typeof raw !== 'object') continue;
        const normalized = this.normalizeCombinedStageResult(stage, raw as Record<string, unknown>);
        if (normalized) {
          const scoped = scopedDiffs.get(stage);
          result[stage] = this.applyDeterministicAnchor(
            stage,
            normalized,
            scoped?.relevantHunks ?? '',
            config,
          );
        }
      }

      return result;
    } catch (err) {
      const details = this.serializeError(err);
      qgLog.error('[QualityGates] Combined AI review failed:', details);
      return result;
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
${diff}
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
        passed: score >= QUALITY_GATE_DEFAULTS.stagePassScore,
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
${diff}
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
        passed: score >= QUALITY_GATE_DEFAULTS.stagePassScore,
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
${diff}
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
        passed: reviewScore >= QUALITY_GATE_DEFAULTS.stagePassScore,
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
   * Design compliance review — checks that the approved design is preserved.
   * Only runs when a DesignArtifact is attached to the task context.
   *
   * Implements REQ-011: Design Compliance Quality Gate
   */
  async runDesignComplianceReview(
    diff: string,
    taskContext: TaskContext,
    config: QualityGateConfig,
    reviewProvider: ReviewProvider,
  ): Promise<QualityGateStageResult> {
    const artifact = taskContext.designArtifact;
    if (!artifact) {
      return { score: 100, passed: true, issues: [], suggestions: [] };
    }

    // Build the design context that replaces {designContext} in the prompt
    const designContext = `### Selected Design: ${artifact.selectedVariantName}

### Design Brief
${artifact.brief}

### Component Spec
${artifact.componentSpec}

### Design Files
${artifact.filePaths.map(f => `- \`${f}\``).join('\n')}

### Stack
- Framework: ${artifact.projectStack.framework}
- TypeScript: ${artifact.projectStack.typescript}
- Styling: ${artifact.projectStack.styling.tailwind ? 'Tailwind CSS' : 'Other'}
- Animation: ${artifact.projectStack.animationLibrary ?? 'None'}
- UI Library: ${artifact.projectStack.uiLibrary ?? 'None'}`;

    const promptTemplate = REVIEW_PROMPTS.design_compliance;
    const systemPrompt = promptTemplate.replace('{designContext}', designContext);

    const userMessage = `Task: ${taskContext.taskDescription || 'No task description provided'}

Code diff to review:
\`\`\`diff
${diff}
\`\`\``;

    try {
      const responseText = await this.callReviewModel(systemPrompt, userMessage, config, reviewProvider);
      const parsed = this.parseAiReviewResponse(responseText);

      if (!parsed) {
        return this.createStageFailureResult(
          'Design compliance review returned an unexpected response format',
          ['Ensure the review model returns valid JSON and rerun design compliance checks'],
        );
      }

      return {
        score: parsed.score,
        passed: parsed.score >= QUALITY_GATE_DEFAULTS.stagePassScore,
        issues: parsed.issues,
        suggestions: parsed.suggestions,
      };
    } catch (err) {
      const errorDetails = this.serializeError(err);
      qgLog.error('[QualityGates] Design compliance review failed:', errorDetails);
      return this.createStageFailureResult(
        `Design compliance stage encountered an error: ${errorDetails.message}`,
        ['Fix the review model/provider setup and rerun design compliance checks'],
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
   * Parse AI review output, tolerating plain-text fallback formats.
   */
  private parseAiReviewResponse(
    responseText: string,
  ): { score: number; issues: string[]; suggestions: string[]; integrationVerified?: boolean } | null {
    const parsed = this.parseJsonObject(responseText);
    if (parsed) {
      const score = Math.max(0, Math.min(100, Number(parsed.score) || 100));
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((i: unknown) => typeof i === 'string')
        : [];
      const suggestions = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((s: unknown) => typeof s === 'string')
        : [];
      return {
        score,
        issues,
        suggestions,
        integrationVerified: typeof parsed.integrationVerified === 'boolean'
          ? parsed.integrationVerified
          : undefined,
      };
    }

    const plainText = responseText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    if (!plainText) return null;

    const scoreMatch = plainText.match(/(?:score|rating)\s*[:=]\s*(\d{1,3})/i)
      ?? plainText.match(/\b(\d{1,3})\s*\/\s*100\b/i);
    const score = scoreMatch
      ? Math.max(0, Math.min(100, Number(scoreMatch[1])))
      : null;

    const bullets = plainText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => /^([-*•]|\d+\.)\s+/.test(line))
      .map(line => line.replace(/^([-*•]|\d+\.)\s+/, '').trim())
      .filter(Boolean);

    const lineItems = plainText
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    const issues = (bullets.length > 0 ? bullets : lineItems).slice(0, 5);
    const suggestions = bullets
      .filter(line => /\b(should|consider|recommend|improve|simplify|refactor|avoid|add)\b/i.test(line))
      .slice(0, 5);

    return {
      score: score ?? (issues.length > 0 ? 65 : 85),
      issues,
      suggestions,
    };
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
      const truncDiff = diff.slice(0, 50000);
      const diffMessage = `Diff:\n\`\`\`\n${truncDiff}\`\`\`\n\nTask: ${taskContext.taskDescription}`;
      const response = config.escalationProvider === 'moonshot'
        ? await this.callMoonshotApi(escalationPrompt, diffMessage, config.escalationModel)
        : await this.callAnthropicApi(escalationPrompt, diffMessage, config.escalationModel);

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
   * Implements REQ-QG-002: Catch implementation-only diffs for feature tasks
   */
  enforceTestFirst(
    diff: string,
    taskContext: TaskContext,
  ): QualityGateStageResult | null {
    if (taskContext.taskType !== 'feature') return null;

    // Phase 'review' means implementation files only, no test files — fail for features
    if (taskContext.tddPhase === 'review') {
      const hasNewSourceFiles = /\+\+\+ b\/.*\.[jt]sx?$/m.test(diff);
      if (hasNewSourceFiles) {
        return {
          score: 0,
          passed: false,
          issues: ['Feature code submitted without test files. TDD requires tests alongside implementation.'],
          suggestions: [
            'Add test files (.test.ts or .spec.ts) covering the new behavior',
            'Use the test-writer skill to generate tests from your requirement IDs',
          ],
        };
      }
    }

    // Phase 'test-writing' means only test files in diff — check they have assertions
    if (taskContext.tddPhase === 'test-writing') {
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
    }

    // Phase 'implementing' means both impl + test files — that's correct TDD
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
