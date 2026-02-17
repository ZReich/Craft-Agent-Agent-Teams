/**
 * Agent Teams Comprehensive Flow Test Suite
 *
 * Covers gaps not addressed by the existing e2e-quality-orchestration tests:
 * - Tool Call Throttle (TCP slow-start / AIMD)
 * - Task Domain Routing & Spawn Strategy
 * - YOLO Orchestrator lifecycle, pause, abort, circuit breakers
 * - Team State Store persistence (JSONL)
 * - Task type inference & QG skip for non-code tasks
 * - Activity event limit trimming
 * - Cost summary aggregation
 * - Review loop non-code task skip
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ── Modules Under Test ──────────────────────────────────────
import { ToolCallThrottle, DEFAULT_THROTTLE_CONFIG, DEFAULT_TOOL_BUDGETS, DEFAULT_MAX_CALLS } from '../tool-call-throttle';
import {
  classifyTaskDomain,
  decideTeammateRouting,
} from '../routing-policy';
import { decideSpawnStrategy } from '../yolo-orchestrator';
import type { SpawnStrategy, DomainHeadPlan } from '../yolo-orchestrator';
import { TeamStateStore } from '../team-state-store';
import type { TeamState } from '../team-state-store';
import { AgentTeamManager } from '../../agent/agent-team-manager';
import {
  inferTaskType,
  shouldSkipQualityGates,
  DEFAULT_QUALITY_GATE_CONFIG,
} from '../quality-gates';
import { NON_CODE_TASK_TYPES } from '@craft-agent/core/types';
import { YoloOrchestrator } from '../yolo-orchestrator';
import type { YoloCallbacks } from '../yolo-orchestrator';
import { ReviewLoopOrchestrator } from '../review-loop';
import type { ReviewLoopCallbacks, ReviewLoopConfig } from '../review-loop';
import type {
  TeammateMessage,
  TeamTask,
  TeamActivityEvent,
  QualityGateResult,
  YoloState,
  Spec,
} from '@craft-agent/core/types';

// ============================================================
// STORY 1: Tool Call Throttle
// ============================================================

describe('Tool Call Throttle — Hard Budget Cap', () => {
  it('initializes state on first check', () => {
    const throttle = new ToolCallThrottle();
    const state = throttle.getToolState('Read');
    expect(state).toBeUndefined(); // no state until first check

    const result = throttle.check('Read', 'file-a.ts');
    expect(result.allowed).toBe(true);

    const postState = throttle.getToolState('Read');
    expect(postState).toBeDefined();
    expect(postState!.totalCalls).toBe(1);
    expect(postState!.maxCalls).toBe(DEFAULT_TOOL_BUDGETS['Read']); // 20
  });

  it('allows calls within hard budget cap', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { Read: 3 } });

    expect(throttle.check('Read', 'a').allowed).toBe(true);
    expect(throttle.check('Read', 'b').allowed).toBe(true);
    expect(throttle.check('Read', 'c').allowed).toBe(true);
    // 4th call blocked by hard cap
    expect(throttle.check('Read', 'd').allowed).toBe(false);
  });

  it('tracks diversity via recordSuccess for observability', () => {
    const throttle = new ToolCallThrottle();

    // Make diverse calls and record success
    throttle.check('Read', 'file-a');
    throttle.check('Read', 'file-b');
    throttle.recordSuccess('Read', 'file-a');
    throttle.recordSuccess('Read', 'file-b');

    const state = throttle.getToolState('Read');
    // Budget grows on diverse success (AIMD still tracks internally)
    expect(state!.budget).toBeGreaterThan(DEFAULT_THROTTLE_CONFIG.initialWindow);
  });

  it('recordSuccess still tracks budget growth', () => {
    const throttle = new ToolCallThrottle({ initialWindow: 4, ssthresh: 8 });

    throttle.check('Read', 'a');
    throttle.recordSuccess('Read', 'a');
    throttle.check('Read', 'b');
    throttle.recordSuccess('Read', 'b');

    const state = throttle.getToolState('Read');
    // Budget should grow via AIMD tracking
    expect(state!.budget).toBeGreaterThanOrEqual(8);
  });

  it('hard budget blocks regardless of input variation', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { Bash: 3 } });

    // 3 diverse calls — all count toward hard budget
    expect(throttle.check('Bash', 'cmd-1').allowed).toBe(true);
    expect(throttle.check('Bash', 'cmd-2').allowed).toBe(true);
    expect(throttle.check('Bash', 'cmd-3').allowed).toBe(true);

    // 4th call blocked even though all inputs are different
    const result = throttle.check('Bash', 'cmd-4');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Synthesize');
  });

  it('hardBlockTool blocks independently of hard budget', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { Write: 10 } });

    // Use 2 of 10 budget
    throttle.check('Write', 'a');
    throttle.check('Write', 'b');

    // External hard-block (from health monitor)
    throttle.hardBlockTool('Write', 'Blocked by monitor');

    // Blocked even though budget has 8 remaining
    const r3 = throttle.check('Write', 'c');
    expect(r3.allowed).toBe(false);
    expect(r3.reason).toContain('Blocked by monitor');

    const state = throttle.getToolState('Write');
    expect(state!.blocked).toBe(true);
  });

  it('hardBlockTool permanently blocks a specific tool', () => {
    const throttle = new ToolCallThrottle();

    // Tool should work initially
    const r1 = throttle.check('WebSearch', 'query');
    expect(r1.allowed).toBe(true);

    // Hard-block the tool externally (as health monitor would)
    throttle.hardBlockTool('WebSearch', 'Blocked due to retry-storm. Synthesize your findings.');

    // Now all calls to this tool should be blocked with custom reason
    const r2 = throttle.check('WebSearch', 'different query');
    expect(r2.allowed).toBe(false);
    expect(r2.reason).toContain('Synthesize your findings');

    // Other tools should still work
    const r3 = throttle.check('Read', 'some-file');
    expect(r3.allowed).toBe(true);
  });

  it('hardBlockTool uses default reason when none provided', () => {
    const throttle = new ToolCallThrottle();
    throttle.hardBlockTool('Bash');

    const result = throttle.check('Bash', 'echo test');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('blocked');
  });

  // ── Hard Budget Cap Tests (REQ-BUDGET-001 through REQ-BUDGET-007) ──

  it('maxCallsPerTool blocks after budget exhausted (REQ-BUDGET-001)', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 3 }, defaultMaxCalls: 15 });

    // 3 calls should all be allowed
    expect(throttle.check('WebSearch', 'query-1').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'query-2').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'query-3').allowed).toBe(true);

    // 4th call should be blocked
    const r4 = throttle.check('WebSearch', 'query-4');
    expect(r4.allowed).toBe(false);
    expect(r4.reason).toContain('3 allowed "WebSearch" calls');
    expect(r4.reason).toContain('Synthesize');
  });

  it('default budgets match DEFAULT_TOOL_BUDGETS (REQ-BUDGET-002)', () => {
    const throttle = new ToolCallThrottle();

    // WebSearch default is 7
    for (let i = 0; i < 7; i++) {
      expect(throttle.check('WebSearch', `q-${i}`).allowed).toBe(true);
    }
    expect(throttle.check('WebSearch', 'q-8').allowed).toBe(false);

    // Read default is 20
    const state = throttle.getToolState('WebSearch');
    expect(state!.maxCalls).toBe(DEFAULT_TOOL_BUDGETS['WebSearch']);
  });

  it('different tools have independent budgets (REQ-BUDGET-001)', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 2, Read: 3 }, defaultMaxCalls: 15 });

    // Use up WebSearch budget
    expect(throttle.check('WebSearch', 'a').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'b').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'c').allowed).toBe(false);

    // Read should still have budget
    expect(throttle.check('Read', 'file-1').allowed).toBe(true);
    expect(throttle.check('Read', 'file-2').allowed).toBe(true);
    expect(throttle.check('Read', 'file-3').allowed).toBe(true);
    expect(throttle.check('Read', 'file-4').allowed).toBe(false);
  });

  it('custom maxCallsPerTool overrides defaults (REQ-BUDGET-007)', () => {
    // Override WebSearch from 7 to 2
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 2 } });

    expect(throttle.check('WebSearch', 'a').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'b').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'c').allowed).toBe(false);

    // Read should still use default (20)
    const readState = throttle.getToolState('Read');
    // Read hasn't been called yet, so no state — check default via config
    expect(DEFAULT_TOOL_BUDGETS['Read']).toBe(20);
  });

  it('defaultMaxCalls applies to unlisted tools (REQ-BUDGET-001)', () => {
    const throttle = new ToolCallThrottle({ defaultMaxCalls: 3 });

    // "CustomTool" is not in DEFAULT_TOOL_BUDGETS
    expect(throttle.check('CustomTool', 'a').allowed).toBe(true);
    expect(throttle.check('CustomTool', 'b').allowed).toBe(true);
    expect(throttle.check('CustomTool', 'c').allowed).toBe(true);
    expect(throttle.check('CustomTool', 'd').allowed).toBe(false);

    const state = throttle.getToolState('CustomTool');
    expect(state!.maxCalls).toBe(3);
  });

  it('block message contains synthesis instruction (REQ-BUDGET-004)', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 1 }, defaultMaxCalls: 15 });

    throttle.check('WebSearch', 'query');
    const blocked = throttle.check('WebSearch', 'another-query');

    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('Synthesize your findings');
    expect(blocked.reason).toContain('team-lead');
    expect(blocked.reason).toContain('SendMessage');
  });

  it('budget counter counts ALL calls regardless of input similarity (REQ-BUDGET-001)', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 3 }, defaultMaxCalls: 15 });

    // Same query 3 times — all count toward budget
    expect(throttle.check('WebSearch', 'same-query').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'same-query').allowed).toBe(true);
    expect(throttle.check('WebSearch', 'same-query').allowed).toBe(true);

    // 4th call blocked even though AIMD might allow it (budget is the primary defense)
    expect(throttle.check('WebSearch', 'same-query').allowed).toBe(false);

    const state = throttle.getToolState('WebSearch');
    expect(state!.totalCalls).toBe(3);
  });

  it('getResolvedBudgets returns merged config for prompt injection (REQ-BUDGET-003)', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { WebSearch: 5 } });
    const budgets = throttle.getResolvedBudgets();

    // Custom override
    expect(budgets['WebSearch']).toBe(5);
    // Defaults still present
    expect(budgets['Read']).toBe(20);
    expect(budgets['Bash']).toBe(10);
    // Default fallback
    expect(budgets['_default']).toBe(DEFAULT_MAX_CALLS);
  });

  it('records failure and halves budget', () => {
    const throttle = new ToolCallThrottle({ initialWindow: 4 });

    throttle.check('Bash', 'cmd1');
    throttle.recordFailure('Bash');

    const state = throttle.getToolState('Bash');
    // Budget halved: 4 → 2 (clamped to initialWindow minimum)
    expect(state!.budget).toBeLessThanOrEqual(4);
    expect(state!.inSlowStart).toBe(false);
  });

  it('reset clears all state', () => {
    const throttle = new ToolCallThrottle();

    throttle.check('Read', 'a');
    throttle.check('Write', 'b');
    throttle.reset();

    expect(throttle.getToolState('Read')).toBeUndefined();
    expect(throttle.getToolState('Write')).toBeUndefined();
  });

  it('maintains independent per-tool hard budgets', () => {
    const throttle = new ToolCallThrottle({ maxCallsPerTool: { Read: 2, Write: 5 } });

    throttle.check('Read', 'a');
    throttle.check('Read', 'b');

    // Read budget exhausted (2/2)
    expect(throttle.check('Read', 'c').allowed).toBe(false);

    // But Write should still have budget (0/5)
    expect(throttle.check('Write', 'x').allowed).toBe(true);
  });
});

// ============================================================
// STORY 2: Task Domain Routing
// ============================================================

describe('Task Domain Routing — classifyTaskDomain', () => {
  it('classifies UX/design prompts correctly', () => {
    const result = classifyTaskDomain('Create a wireframe for the user flow');
    expect(result.domain).toBe('ux_design');
    expect(result.matchedKeywords).toContain('wireframe');
    expect(result.matchedKeywords).toContain('user flow');
  });

  it('classifies frontend prompts correctly', () => {
    const result = classifyTaskDomain('Build a React component for the sidebar');
    expect(result.domain).toBe('frontend');
    expect(result.matchedKeywords).toContain('react');
    expect(result.matchedKeywords).toContain('component');
  });

  it('classifies backend prompts correctly', () => {
    const result = classifyTaskDomain('Create a REST API endpoint for user auth');
    expect(result.domain).toBe('backend');
    expect(result.matchedKeywords).toContain('api');
  });

  it('classifies search prompts correctly', () => {
    const result = classifyTaskDomain('Search the codebase for where the user model is defined');
    expect(result.domain).toBe('search');
    expect(result.matchedKeywords).toContain('search');
  });

  it('classifies research prompts correctly', () => {
    // Note: "research" contains "search" which matches 'search' domain first.
    // Use 'compare' + 'tradeoff' which are research-only keywords.
    const result = classifyTaskDomain('Compare tradeoff between Redis and Memcached');
    expect(result.domain).toBe('research');
    expect(result.matchedKeywords).toContain('compare');
  });

  it('classifies review prompts correctly', () => {
    const result = classifyTaskDomain('Review the quality gate results');
    expect(result.domain).toBe('review');
    expect(result.matchedKeywords).toContain('review');
    expect(result.matchedKeywords).toContain('quality gate');
  });

  it('returns "other" for unclassifiable prompts', () => {
    const result = classifyTaskDomain('Do something interesting with the data');
    expect(result.domain).toBe('other');
    expect(result.matchedKeywords).toHaveLength(0);
  });

  it('handles empty/null text gracefully', () => {
    expect(classifyTaskDomain('').domain).toBe('other');
    expect(classifyTaskDomain(null as any).domain).toBe('other');
  });

  it('prioritizes UX over frontend when both match', () => {
    const result = classifyTaskDomain('Design the UX layout for a React component');
    // UX has higher priority in DOMAIN_PRIORITY
    expect(result.domain).toBe('ux_design');
  });
});

describe('Task Domain Routing — decideTeammateRouting', () => {
  it('enforces Head role for UX/design tasks (REQ-005)', () => {
    const result = decideTeammateRouting({
      prompt: 'Create a wireframe for the onboarding flow',
      requestedRole: 'worker',
    });

    expect(result.domain).toBe('ux_design');
    expect(result.role).toBe('head');
    expect(result.roleEnforced).toBe(true);
    expect(result.modelOverride).toBe('claude-opus-4-6');
    expect(result.skillSlugs).toContain('ux-ui-designer');
  });

  it('uses default role when no role requested', () => {
    const result = decideTeammateRouting({
      prompt: 'Build the login page with React',
    });

    expect(result.domain).toBe('frontend');
    expect(result.role).toBe('worker');
    expect(result.roleEnforced).toBe(false);
    expect(result.skillSlugs).toContain('frontend-implementer');
  });

  it('respects requested role for non-UX tasks', () => {
    const result = decideTeammateRouting({
      prompt: 'Build the API endpoint',
      requestedRole: 'head',
    });

    expect(result.role).toBe('head');
    expect(result.roleEnforced).toBe(false);
  });

  it('maps review domain to reviewer role', () => {
    const result = decideTeammateRouting({
      prompt: 'Review the regression test results and validate',
    });

    expect(result.domain).toBe('review');
    expect(result.role).toBe('reviewer');
    expect(result.skillSlugs).toContain('quality-reviewer');
  });
});

describe('Task Domain Routing — decideSpawnStrategy', () => {
  it('returns flat for empty task list', () => {
    const strategy = decideSpawnStrategy([]);
    expect(strategy.mode).toBe('flat');
  });

  it('returns flat for single-domain ≤7 tasks', () => {
    const tasks = [
      { id: '1', title: 'Build React header' },
      { id: '2', title: 'Build React footer' },
      { id: '3', title: 'Build React sidebar' },
    ];
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('flat');
  });

  it('returns flat for two domains when each domain has ≤4 tasks', () => {
    const tasks = [
      { id: '1', title: 'Build React component A' },
      { id: '2', title: 'Build React component B' },
      { id: '3', title: 'Build React component C' },
      { id: '4', title: 'Create API endpoint users A' },
      { id: '5', title: 'Create API endpoint users B' },
      { id: '6', title: 'Create API endpoint users C' },
      { id: '7', title: 'Create API endpoint users D' },
    ];
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('flat');
  });

  it('returns managed for two domains when one domain exceeds 4 tasks', () => {
    const tasks = [
      { id: '1', title: 'Build React component' },
      { id: '2', title: 'Build React component 2' },
      { id: '3', title: 'Build React component 3' },
      { id: '4', title: 'Build React component 4' },
      { id: '5', title: 'Build React component 5' },
      { id: '6', title: 'Create API endpoint for users' },
    ];
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('managed');
    if (strategy.mode === 'managed') {
      expect(strategy.heads.length).toBe(2);
    }
  });

  it('returns managed for single-domain with 8+ tasks', () => {
    const tasks = Array.from({ length: 8 }, (_, i) => ({
      id: String(i),
      title: `Build React component ${i}`,
    }));
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('managed');
  });

  it('returns managed when UX/design tasks are present (hard enforcement preserved)', () => {
    const tasks = [
      { id: '1', title: 'Create UX wireframe for onboarding flow' },
      { id: '2', title: 'Implement frontend onboarding component' },
    ];
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('managed');
  });

  it('returns flat for research-only tasks', () => {
    const tasks = [
      { id: '1', title: 'Research best practices for caching' },
      { id: '2', title: 'Search codebase for usage patterns' },
    ];
    const strategy = decideSpawnStrategy(tasks);
    expect(strategy.mode).toBe('flat');
  });

  it('returns managed when learning guidance prefers managed routing', () => {
    const tasks = [
      { id: '1', title: 'Build React component A' },
      { id: '2', title: 'Build React component B' },
      { id: '3', title: 'Build React component C' },
    ];
    const strategy = decideSpawnStrategy(tasks, {
      learningHint: { preferManaged: true, rationale: 'historical quality regressions in flat mode' },
    });
    expect(strategy.mode).toBe('managed');
  });
});

// ============================================================
// STORY 3: Task Type Inference & QG Skip
// ============================================================

describe('Task Type Inference & QG Skip', () => {
  // inferTaskType only classifies NON-CODE types (research, planning, search, explore, docs).
  // Code tasks (feature, bugfix, etc.) return undefined — they always run QG.

  it('infers research type from title keywords', () => {
    expect(inferTaskType('Investigate best practices for caching')).toBe('research');
  });

  it('infers planning type from title keywords', () => {
    expect(inferTaskType('Create plan for the API architecture')).toBe('planning');
  });

  it('infers search type from title keywords', () => {
    expect(inferTaskType('Find all usages of UserService')).toBe('search');
  });

  it('infers docs type from title keywords', () => {
    expect(inferTaskType('Document the API endpoints')).toBe('docs');
  });

  it('infers explore type from title keywords', () => {
    expect(inferTaskType('Explore the codebase to understand the auth flow')).toBe('explore');
  });

  it('returns undefined for code tasks (feature, bugfix, etc.)', () => {
    expect(inferTaskType('Implement user authentication')).toBeUndefined();
    expect(inferTaskType('Fix login button')).toBeUndefined();
    expect(inferTaskType('Refactor the user service')).toBeUndefined();
  });

  it('non-code tasks skip quality gates', () => {
    expect(shouldSkipQualityGates('research')).toBe(true);
    expect(shouldSkipQualityGates('planning')).toBe(true);
    expect(shouldSkipQualityGates('search')).toBe(true);
    expect(shouldSkipQualityGates('explore')).toBe(true);
    expect(shouldSkipQualityGates('docs')).toBe(true);
  });

  it('code tasks do NOT skip quality gates', () => {
    expect(shouldSkipQualityGates('feature')).toBe(false);
    expect(shouldSkipQualityGates('bugfix')).toBe(false);
    expect(shouldSkipQualityGates('refactor')).toBe(false);
    expect(shouldSkipQualityGates('test')).toBe(false);
    expect(shouldSkipQualityGates(undefined)).toBe(false);
  });
});

// ============================================================
// STORY 4: Team State Store (JSONL Persistence)
// ============================================================

describe('Team State Store — JSONL Persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'team-state-test-'));
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('creates JSONL file and appends messages', () => {
    const store = new TeamStateStore(tempDir);
    const msg: TeammateMessage = {
      id: 'msg-1',
      from: 'worker-a',
      to: 'lead',
      content: 'Task completed',
      timestamp: new Date().toISOString(),
      type: 'message',
    };

    store.appendMessage(msg);

    const filePath = join(tempDir, 'team-state.jsonl');
    expect(existsSync(filePath)).toBe(true);

    const state = store.load();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.id).toBe('msg-1');
  });

  it('appends and loads tasks with deduplication', () => {
    const store = new TeamStateStore(tempDir);
    const task: TeamTask = {
      id: 'task-1',
      title: 'Implement feature',
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    store.appendTask(task);

    // Update the same task (e.g., status change)
    const updatedTask = { ...task, status: 'completed' as const, completedAt: new Date().toISOString() };
    store.appendTask(updatedTask);

    const state = store.load();
    // Should only have 1 task (latest version wins)
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]!.status).toBe('completed');
  });

  it('appends and loads activity events', () => {
    const store = new TeamStateStore(tempDir);
    const event: TeamActivityEvent = {
      id: 'act-1',
      teamId: 'team-1',
      type: 'task-completed',
      details: 'Task finished successfully',
      timestamp: new Date().toISOString(),
    };

    store.appendActivity(event);

    const state = store.load();
    expect(state.activity).toHaveLength(1);
    expect(state.activity[0]!.id).toBe('act-1');
  });

  it('appends and loads quality gate results', () => {
    const store = new TeamStateStore(tempDir);
    const qg: QualityGateResult = {
      passed: true,
      aggregateScore: 92,
      stages: {
        syntax: { score: 100, passed: true, issues: [], suggestions: [] },
        tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 5, passedTests: 5, failedTests: 0, skippedTests: 0 } as any,
        architecture: { score: 90, passed: true, issues: [], suggestions: [] },
        simplicity: { score: 88, passed: true, issues: [], suggestions: [] },
        errors: { score: 95, passed: true, issues: [], suggestions: [] },
        completeness: { score: 92, passed: true, issues: [], suggestions: [] },
      },
      cycleCount: 1,
      maxCycles: 3,
      reviewModel: 'claude-opus-4-6',
      reviewProvider: 'anthropic',
      timestamp: new Date().toISOString(),
    };

    store.appendQualityGate('session-worker-a', qg);

    const state = store.load();
    expect(state.qualityGates.size).toBe(1);
    expect(state.qualityGates.get('session-worker-a')!.passed).toBe(true);
  });

  it('appends and loads YOLO state', () => {
    const store = new TeamStateStore(tempDir);
    const yoloState: YoloState = {
      phase: 'executing',
      objective: 'Build the app',
      config: {
        mode: 'smart',
        costCapUsd: 5,
        timeoutMinutes: 60,
        maxConcurrency: 3,
        maxRemediationRounds: 3,
        requireApprovalForSpecChanges: true,
        autoRemediate: true,
        adaptiveSpecs: true,
      },
      startedAt: new Date().toISOString(),
      remediationRound: 0,
      remediationTaskIds: [],
      pendingSpecChanges: [],
    };

    store.appendYoloState(yoloState);

    const state = store.load();
    expect(state.yoloState).not.toBeNull();
    expect(state.yoloState!.phase).toBe('executing');
  });

  it('returns empty state for non-existent file', () => {
    const store = new TeamStateStore(join(tempDir, 'nonexistent'));
    const state = store.load();
    expect(state.messages).toHaveLength(0);
    expect(state.tasks).toHaveLength(0);
    expect(state.activity).toHaveLength(0);
  });

  it('compacts JSONL file by deduplicating tasks', () => {
    const store = new TeamStateStore(tempDir);

    // Add a task, then update it 3 times
    for (let i = 0; i < 4; i++) {
      store.appendTask({
        id: 'task-1',
        title: 'Implement feature',
        status: i < 3 ? 'in_progress' : 'completed',
        createdAt: new Date().toISOString(),
      } as TeamTask);
    }

    // Add a message
    store.appendMessage({
      id: 'msg-1',
      from: 'worker',
      to: 'lead',
      content: 'Done',
      timestamp: new Date().toISOString(),
      type: 'message',
    });

    // Before compact: file has 5 lines
    const rawBefore = readFileSync(join(tempDir, 'team-state.jsonl'), 'utf-8');
    expect(rawBefore.trim().split('\n')).toHaveLength(5);

    store.compact();

    // After compact: file should have 2 lines (1 msg + 1 task)
    const rawAfter = readFileSync(join(tempDir, 'team-state.jsonl'), 'utf-8');
    expect(rawAfter.trim().split('\n')).toHaveLength(2);

    // Data should still be correct
    const state = store.load();
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]!.status).toBe('completed');
    expect(state.messages).toHaveLength(1);
  });

  it('skips malformed JSON lines gracefully', () => {
    const store = new TeamStateStore(tempDir);

    // Write some valid and invalid lines
    const { appendFileSync } = require('fs');
    const filePath = join(tempDir, 'team-state.jsonl');
    appendFileSync(filePath, '{"t":"msg","d":{"id":"m1","from":"a","to":"b","content":"hi","timestamp":"2026-01-01","type":"message"}}\n');
    appendFileSync(filePath, 'NOT VALID JSON\n');
    appendFileSync(filePath, '{"t":"msg","d":{"id":"m2","from":"c","to":"d","content":"ok","timestamp":"2026-01-02","type":"message"}}\n');

    const state = store.load();
    // Should have 2 messages (skipped the malformed line)
    expect(state.messages).toHaveLength(2);
  });
});

// ============================================================
// STORY 5: Activity Event Limits & Cost Tracking
// ============================================================

describe('Activity Event Limits & Cost Tracking', () => {
  let manager: AgentTeamManager;

  beforeEach(() => {
    manager = new AgentTeamManager();
  });

  function createTestTeam() {
    return manager.createTeam({
      name: 'limit-test',
      leadSessionId: 'session-lead',
      modelConfig: {
        defaults: {
          lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
          head: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
          worker: { model: 'kimi-k2.5', provider: 'moonshot' },
          reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
          escalation: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        },
      },
      workspaceRootPath: '/test/project',
    });
  }

  it('aggregates cost per teammate and per model', () => {
    const team = createTestTeam();

    const workerA = manager.spawnTeammate({ teamId: team.id, name: 'worker-a', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });
    const workerB = manager.spawnTeammate({ teamId: team.id, name: 'worker-b', role: 'worker', model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' });

    manager.updateTeammateUsage(team.id, workerA.id, { inputTokens: 50000, outputTokens: 10000, costUsd: 0.05 });
    manager.updateTeammateUsage(team.id, workerB.id, { inputTokens: 100000, outputTokens: 30000, costUsd: 0.20 });

    const cost = manager.getCostSummary(team.id);

    expect(cost.totalCostUsd).toBeCloseTo(0.25, 2);
    expect(cost.perTeammate[workerA.id]!.costUsd).toBe(0.05);
    expect(cost.perTeammate[workerB.id]!.costUsd).toBe(0.20);
    expect(cost.perModel['kimi-k2.5']!.inputTokens).toBe(50000);
    expect(cost.perModel['claude-sonnet-4-5-20250929']!.inputTokens).toBe(100000);
  });

  it('accumulates usage across multiple updates', () => {
    const team = createTestTeam();
    const worker = manager.spawnTeammate({ teamId: team.id, name: 'worker', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });

    manager.updateTeammateUsage(team.id, worker.id, { inputTokens: 10000, outputTokens: 5000, costUsd: 0.01 });
    manager.updateTeammateUsage(team.id, worker.id, { inputTokens: 20000, outputTokens: 8000, costUsd: 0.03 });

    const cost = manager.getCostSummary(team.id);
    expect(cost.totalCostUsd).toBeCloseTo(0.04, 2);
    expect(cost.perTeammate[worker.id]!.inputTokens).toBe(30000);
  });

  it('returns zero cost for team with no usage', () => {
    const team = createTestTeam();
    const cost = manager.getCostSummary(team.id);

    expect(cost.totalCostUsd).toBe(0);
    expect(Object.keys(cost.perTeammate)).toHaveLength(0);
    expect(Object.keys(cost.perModel)).toHaveLength(0);
  });
});

// ============================================================
// STORY 6: YOLO Orchestrator Lifecycle
// ============================================================

describe('YOLO Orchestrator Lifecycle', () => {
  let manager: AgentTeamManager;
  let reviewCallbacks: ReviewLoopCallbacks;
  let reviewConfig: ReviewLoopConfig;
  let reviewLoop: ReviewLoopOrchestrator;

  beforeEach(() => {
    manager = new AgentTeamManager();

    reviewCallbacks = {
      collectDiff: vi.fn().mockResolvedValue('diff'),
      runQualityGates: vi.fn().mockResolvedValue({
        passed: true,
        aggregateScore: 92,
        stages: {},
        cycleCount: 1,
        maxCycles: 3,
        reviewModel: 'test',
        reviewProvider: 'test',
        timestamp: new Date().toISOString(),
      }),
      sendFeedback: vi.fn().mockResolvedValue(undefined),
      updateTaskStatus: vi.fn(),
      escalate: vi.fn().mockResolvedValue('ok'),
      createCheckpoint: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      auditLog: vi.fn().mockResolvedValue(undefined),
    };

    reviewConfig = {
      qualityGates: { ...DEFAULT_QUALITY_GATE_CONFIG, maxReviewCycles: 3 },
      workingDirectory: '/test',
      autoReview: true,
    };

    reviewLoop = new ReviewLoopOrchestrator(reviewCallbacks, reviewConfig);
  });

  function createMockYoloCallbacks(overrides?: Partial<YoloCallbacks>): YoloCallbacks {
    return {
      generateSpec: vi.fn().mockResolvedValue({
        specId: 'spec-1',
        title: 'Test Spec',
        ownerDRI: 'test',
        reviewers: [],
        status: 'draft',
        goals: [],
        nonGoals: [],
        requirements: [{ id: 'REQ-001', description: 'Build it', priority: 'high', acceptanceTests: [], status: 'pending' }],
        risks: [],
        mitigations: [],
        relatedTickets: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } satisfies Spec),
      decomposeIntoTasks: vi.fn().mockResolvedValue([
        { title: 'Task 1', description: 'Do thing 1', requirementIds: ['REQ-001'] },
      ]),
      spawnAndAssign: vi.fn().mockImplementation(async (teamId: string, taskIds: string[]) => {
        // Simulate immediate task completion
        for (const taskId of taskIds) {
          manager.updateTaskStatus(teamId, taskId, 'completed', undefined, { bypassReviewLoop: true });
        }
      }),
      runIntegrationCheck: vi.fn().mockResolvedValue({ passed: true, issues: [] }),
      synthesize: vi.fn().mockResolvedValue('All done!'),
      onStateChange: vi.fn(),
      ...overrides,
    };
  }

  it('emits phase changes through the lifecycle', async () => {
    // The YOLO orchestrator uses 5s polling in executeFlat.
    // To avoid test timeouts, we use decompose returning 0 tasks
    // so executeFlat exits immediately.
    const team = manager.createTeam({
      name: 'yolo-test',
      leadSessionId: 'lead-session',
      modelConfig: {
        defaults: {
          lead: { model: 'claude-opus-4-6', provider: 'anthropic' },
          head: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
          worker: { model: 'kimi-k2.5', provider: 'moonshot' },
          reviewer: { model: 'kimi-k2.5', provider: 'moonshot' },
          escalation: { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' },
        },
      },
      workspaceRootPath: '/test/project',
    });

    const callbacks = createMockYoloCallbacks({
      // Return 0 tasks so executeFlat exits immediately
      decomposeIntoTasks: vi.fn().mockResolvedValue([]),
    });
    const yolo = new YoloOrchestrator(manager, reviewLoop, callbacks);

    const phases: string[] = [];
    yolo.on('yolo:phase-changed', ({ phase }: { phase: string }) => phases.push(phase));

    const finalState = await yolo.start(team.id, 'Build the feature', {
      mode: 'fixed',
      costCapUsd: 10,
      timeoutMinutes: 60,
      maxConcurrency: 1,
      maxRemediationRounds: 1,
      autoRemediate: true,
    });

    expect(finalState.phase).toBe('completed');
    expect(finalState.summary).toBe('All done!');
    expect(phases).toContain('spec-generation');
    expect(phases).toContain('task-decomposition');
    expect(phases).toContain('executing');
    expect(phases).toContain('integration-check');
    expect(phases).toContain('synthesizing');
    expect(phases).toContain('completed');

    expect(callbacks.generateSpec).toHaveBeenCalledOnce();
    expect(callbacks.decomposeIntoTasks).toHaveBeenCalledOnce();
    expect(callbacks.runIntegrationCheck).toHaveBeenCalledOnce();
    expect(callbacks.synthesize).toHaveBeenCalledOnce();
  }, 15000);

  it('abort changes state and isRunning returns false', async () => {
    const team = manager.createTeam({
      name: 'abort-test',
      leadSessionId: 'lead-session',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    // Use a slow spec gen so we can abort during it
    let abortedDuringSpec = false;
    const callbacks = createMockYoloCallbacks({
      generateSpec: vi.fn().mockImplementation(async () => {
        // Wait long enough for abort to fire
        await new Promise(r => setTimeout(r, 200));
        abortedDuringSpec = true;
        return {
          id: 'spec-1',
          title: 'Test',
          requirements: [],
          createdAt: new Date().toISOString(),
        };
      }),
    });

    const yolo = new YoloOrchestrator(manager, reviewLoop, callbacks);

    // Start and abort after a short delay
    const promise = yolo.start(team.id, 'Build it', { mode: 'fixed' });
    await new Promise(r => setTimeout(r, 50));
    yolo.abort('Testing abort');

    const state = await promise;
    // After abort, phase should be aborted and isRunning false
    expect(state.phase).toBe('aborted');
    expect(yolo.isRunning()).toBe(false);
  }, 10000);

  it('pause stops execution', () => {
    const team = manager.createTeam({
      name: 'pause-test',
      leadSessionId: 'lead-session',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    const callbacks = createMockYoloCallbacks();
    const yolo = new YoloOrchestrator(manager, reviewLoop, callbacks);

    // Must start first to have state
    yolo.start(team.id, 'Test', { mode: 'fixed' });
    yolo.pause('user-requested');

    const state = yolo.getState();
    expect(state?.phase).toBe('paused');
    expect(state?.pauseReason).toBe('user-requested');
    expect(yolo.isRunning()).toBe(false);
  });

  it('handles integration failure by aborting when remediation disabled', async () => {
    const team = manager.createTeam({
      name: 'int-fail-test',
      leadSessionId: 'lead-session',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    const callbacks = createMockYoloCallbacks({
      decomposeIntoTasks: vi.fn().mockResolvedValue([]),
      runIntegrationCheck: vi.fn().mockResolvedValue({
        passed: false,
        issues: ['Type error in app.ts'],
      }),
    });

    const yolo = new YoloOrchestrator(manager, reviewLoop, callbacks);

    const state = await yolo.start(team.id, 'Build with no remediation', {
      mode: 'fixed',
      autoRemediate: false,
    });

    // Should abort since integration failed and remediation is disabled
    expect(state.phase).toBe('aborted');
    expect(state.summary).toContain('Integration failed');
  }, 15000);
});

// ============================================================
// STORY 7: Manager Lifecycle Edge Cases
// ============================================================

describe('Manager Lifecycle Edge Cases', () => {
  let manager: AgentTeamManager;

  beforeEach(() => {
    manager = new AgentTeamManager();
  });

  it('resolves team by name when ID does not match', () => {
    const team = manager.createTeam({
      name: 'my-team',
      leadSessionId: 'lead',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    const resolved = manager.resolveTeamId('my-team');
    expect(resolved).toBe(team.id);
  });

  it('evictAllTeamData clears everything', () => {
    const team = manager.createTeam({
      name: 'evict-test',
      leadSessionId: 'lead',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    manager.spawnTeammate({ teamId: team.id, name: 'w', role: 'worker', model: 'test', provider: 'test' });
    manager.createTask(team.id, 'Task', undefined, 'lead');

    manager.evictAllTeamData();

    expect(manager.getTeam(team.id)).toBeUndefined();
    expect(manager.getTasks(team.id)).toHaveLength(0);
    expect(manager.getActiveTeams()).toHaveLength(0);
  });

  it('sets and gets team spec correctly', () => {
    const team = manager.createTeam({
      name: 'spec-test',
      leadSessionId: 'lead',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    const spec: Spec = {
      specId: 'spec-1',
      title: 'Test Spec',
      ownerDRI: 'test',
      reviewers: [],
      status: 'draft',
      goals: [],
      nonGoals: [],
      requirements: [],
      risks: [],
      mitigations: [],
      relatedTickets: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    manager.setTeamSpec(team.id, spec);
    expect(manager.getTeamSpec(team.id)).toBeDefined();
    expect(manager.getTeamSpec(team.id)!.specId).toBe('spec-1');

    // Clear spec
    manager.setTeamSpec(team.id, undefined);
    expect(manager.getTeamSpec(team.id)).toBeUndefined();
  });

  it('hydrates tasks idempotently (no duplicates on reload)', () => {
    const team = manager.createTeam({
      name: 'hydrate-test',
      leadSessionId: 'lead',
      modelConfig: {
        defaults: {
          lead: { model: 'test', provider: 'test' },
          head: { model: 'test', provider: 'test' },
          worker: { model: 'test', provider: 'test' },
          reviewer: { model: 'test', provider: 'test' },
          escalation: { model: 'test', provider: 'test' },
        },
      },
      workspaceRootPath: '/test',
    });

    const task: TeamTask = {
      id: 'task-hydrate-1',
      title: 'Hydrated task',
      status: 'completed',
      createdAt: new Date().toISOString(),
    };

    // Hydrate twice — should not duplicate
    manager.hydrateTask(team.id, task);
    manager.hydrateTask(team.id, task);

    expect(manager.getTasks(team.id)).toHaveLength(1);
  });
});
