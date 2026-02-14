/**
 * End-to-End Quality Orchestration Test Suite
 *
 * Tests the FULL agent teams pipeline: team creation â†’ task assignment â†’
 * quality gating â†’ review loops â†’ escalation â†’ integration verification â†’ audit trail.
 *
 * All external I/O (git, filesystem, LLM calls) is mocked.
 * Only real orchestration logic is exercised.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentTeamManager } from '../../agent/agent-team-manager';
import { ReviewLoopOrchestrator, type ReviewLoopCallbacks, type ReviewLoopConfig } from '../review-loop';
import {
  computeAggregateScore,
  shouldPass,
  formatFailureReport,
  formatSuccessReport,
  mergeQualityGateConfig,
  DEFAULT_QUALITY_GATE_CONFIG,
} from '../quality-gates';
import { TeammateHealthMonitor } from '../health-monitor';
import { FileOwnershipTracker } from '../file-tracker';
import type {
  QualityGateConfig,
  QualityGateResult,
  QualityGateStageResult,
  QualityGateStageName,
  TeamTask,
  TeamTaskStatus,
} from '@craft-agent/core/types';

// ============================================================
// Test Helpers & Factories
// ============================================================

/** Create a passing QualityGateResult */
function createPassingResult(overrides?: Partial<QualityGateResult>): QualityGateResult {
  return {
    passed: true,
    aggregateScore: 92,
    stages: {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 10, passedTests: 10, failedTests: 0, skippedTests: 0 } as any,
      architecture: { score: 90, passed: true, issues: [], suggestions: ['Consider extracting shared logic'] },
      simplicity: { score: 88, passed: true, issues: [], suggestions: [] },
      errors: { score: 95, passed: true, issues: [], suggestions: [] },
      completeness: { score: 92, passed: true, issues: [], suggestions: [] },
    },
    cycleCount: 1,
    maxCycles: 5,
    reviewModel: 'kimi-k2.5',
    reviewProvider: 'moonshot',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a failing QualityGateResult */
function createFailingResult(overrides?: Partial<QualityGateResult>): QualityGateResult {
  return {
    passed: false,
    aggregateScore: 65,
    stages: {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 8, passedTests: 8, failedTests: 0, skippedTests: 0 } as any,
      architecture: { score: 50, passed: false, issues: ['God class detected in UserService', 'Missing interface for data access layer'], suggestions: ['Extract repository pattern'] },
      simplicity: { score: 60, passed: false, issues: ['Overly nested conditionals in processOrder()'], suggestions: ['Use early returns'] },
      errors: { score: 70, passed: false, issues: ['Unhandled promise rejection in fetchData()'], suggestions: ['Add try/catch'] },
      completeness: { score: 80, passed: true, issues: [], suggestions: [] },
    },
    cycleCount: 1,
    maxCycles: 5,
    reviewModel: 'kimi-k2.5',
    reviewProvider: 'moonshot',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a result that fails binary gates (syntax/tests) */
function createBinaryFailResult(): QualityGateResult {
  return {
    passed: false,
    aggregateScore: 0,
    stages: {
      syntax: { score: 0, passed: false, issues: ['error TS2304: Cannot find name "foo"', 'error TS2345: Argument type mismatch'], suggestions: [] },
      tests: { score: 0, passed: false, issues: ['3 tests failed'], suggestions: [], totalTests: 10, passedTests: 7, failedTests: 3, skippedTests: 0 } as any,
      architecture: { score: 0, passed: false, issues: [], suggestions: [] },
      simplicity: { score: 0, passed: false, issues: [], suggestions: [] },
      errors: { score: 0, passed: false, issues: [], suggestions: [] },
      completeness: { score: 0, passed: false, issues: [], suggestions: [] },
    },
    cycleCount: 1,
    maxCycles: 5,
    reviewModel: 'kimi-k2.5',
    reviewProvider: 'moonshot',
    timestamp: new Date().toISOString(),
  };
}

/** Create mock ReviewLoopCallbacks */
function createMockCallbacks(overrides?: Partial<ReviewLoopCallbacks>): ReviewLoopCallbacks {
  return {
    collectDiff: vi.fn().mockResolvedValue('diff --git a/src/app.ts b/src/app.ts\n+export function hello() { return "world"; }'),
    runQualityGates: vi.fn().mockResolvedValue(createPassingResult()),
    sendFeedback: vi.fn().mockResolvedValue(undefined),
    updateTaskStatus: vi.fn(),
    escalate: vi.fn().mockResolvedValue('Escalation diagnosis: The persistent issue is in the UserService constructor. Apply dependency injection.'),
    createCheckpoint: vi.fn().mockResolvedValue(undefined),
    rollback: vi.fn().mockResolvedValue(undefined),
    auditLog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Default ReviewLoopConfig for tests */
function createTestConfig(overrides?: Partial<ReviewLoopConfig>): ReviewLoopConfig {
  return {
    qualityGates: { ...DEFAULT_QUALITY_GATE_CONFIG, maxReviewCycles: 3 },
    workingDirectory: '/test/project',
    autoReview: true,
    ...overrides,
  };
}

/**
 * Wire up real ReviewLoop â†” AgentTeamManager integration.
 * The critical piece: updateTaskStatus callback calls back into the manager
 * with bypassReviewLoop: true to close the loop.
 */
function createWiredSystem(opts?: {
  maxCycles?: number;
  gateConfig?: Partial<QualityGateConfig>;
  callbackOverrides?: Partial<ReviewLoopCallbacks>;
}) {
  const manager = new AgentTeamManager();
  const events: Record<string, any[]> = {};

  const config = createTestConfig({
    qualityGates: {
      ...DEFAULT_QUALITY_GATE_CONFIG,
      maxReviewCycles: opts?.maxCycles ?? 3,
      ...opts?.gateConfig,
    },
  });

  // Wire the callback so review loop â†’ manager â†’ actual task state update
  const callbacks = createMockCallbacks({
    updateTaskStatus: (teamId: string, taskId: string, status: string, assignee?: string, options?: { bypassReviewLoop?: boolean }) => {
      manager.updateTaskStatus(teamId, taskId, status as TeamTaskStatus, assignee, options);
    },
    ...opts?.callbackOverrides,
  });

  const reviewLoop = new ReviewLoopOrchestrator(callbacks, config);

  // Attach review loop to manager
  manager.setReviewLoop(reviewLoop);

  // Capture events
  for (const eventName of ['review:started', 'review:passed', 'review:failed', 'review:escalating', 'review:escalated', 'review:error']) {
    events[eventName] = [];
    reviewLoop.on(eventName, (data: any) => events[eventName]!.push(data));
  }

  const managerEvents: Record<string, any[]> = {};
  for (const eventName of ['team:created', 'task:created', 'task:updated', 'teammate:spawned', 'synthesis:requested', 'activity']) {
    managerEvents[eventName] = [];
    manager.on(eventName, (data: any) => managerEvents[eventName]!.push(data));
  }

  return { manager, reviewLoop, callbacks, events, managerEvents, config };
}

/** Helper to create a team with teammates and tasks for integration tests */
function setupTeamWithTasks(manager: AgentTeamManager, taskCount = 2) {
  const team = manager.createTeam({
    name: 'test-team',
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

  // Spawn teammates
  const workerA = manager.spawnTeammate({
    teamId: team.id,
    name: 'worker-a',
    role: 'worker',
    model: 'kimi-k2.5',
    provider: 'moonshot',
  });

  const workerB = manager.spawnTeammate({
    teamId: team.id,
    name: 'worker-b',
    role: 'worker',
    model: 'kimi-k2.5',
    provider: 'moonshot',
  });

  // Create and assign tasks
  const tasks: TeamTask[] = [];
  for (let i = 0; i < taskCount; i++) {
    const assignee = i % 2 === 0 ? workerA.id : workerB.id;
    const task = manager.createTask(
      team.id,
      `Task ${i + 1}: Implement feature ${String.fromCharCode(65 + i)}`,
      `Detailed description for feature ${String.fromCharCode(65 + i)}`,
      'lead',
      { assignee },
    );
    manager.updateTaskStatus(team.id, task.id, 'in_progress', assignee);
    tasks.push(task);
  }

  return { team, workerA, workerB, tasks };
}

// ============================================================
// SCENARIO 1: Full Team Lifecycle (no quality gates)
// ============================================================

describe('Full Team Lifecycle', () => {
  let manager: AgentTeamManager;

  beforeEach(() => {
    manager = new AgentTeamManager();
  });

  it('creates team, spawns teammates, and assigns tasks', () => {
    const team = manager.createTeam({
      name: 'lifecycle-team',
      leadSessionId: 'session-lead-1',
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

    expect(team.status).toBe('active');
    expect(team.members).toHaveLength(0);

    // Spawn 3 teammates
    const lead = manager.spawnTeammate({ teamId: team.id, name: 'lead', role: 'lead', model: 'claude-opus-4-6', provider: 'anthropic' });
    const workerA = manager.spawnTeammate({ teamId: team.id, name: 'worker-a', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });
    const workerB = manager.spawnTeammate({ teamId: team.id, name: 'worker-b', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });

    expect(team.members).toHaveLength(3);
    expect(lead.status).toBe('spawning');
    expect(workerA.model).toBe('kimi-k2.5');

    // Create and assign tasks
    const task1 = manager.createTask(team.id, 'Build auth module', 'Implement JWT auth', 'lead', { assignee: workerA.id });
    const task2 = manager.createTask(team.id, 'Build user API', 'REST endpoints for users', 'lead', { assignee: workerB.id });
    const task3 = manager.createTask(team.id, 'Write tests', 'Unit + integration tests', 'lead', { assignee: workerA.id });

    expect(manager.getTasks(team.id)).toHaveLength(3);
    expect(task1.status).toBe('pending');
    expect(task1.assignee).toBe(workerA.id);

    // Move to in_progress
    manager.updateTaskStatus(team.id, task1.id, 'in_progress', workerA.id);
    const updated = manager.getTasks(team.id).find(t => t.id === task1.id);
    expect(updated?.status).toBe('in_progress');
  });

  it('triggers synthesis when all teammate tasks complete (no review loop)', () => {
    const synthesisEvents: any[] = [];
    manager.on('synthesis:requested', (data) => synthesisEvents.push(data));

    const team = manager.createTeam({
      name: 'synth-team',
      leadSessionId: 'session-lead-2',
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

    const worker = manager.spawnTeammate({ teamId: team.id, name: 'solo-worker', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });

    const task1 = manager.createTask(team.id, 'Task 1', undefined, 'lead', { assignee: worker.id });
    const task2 = manager.createTask(team.id, 'Task 2', undefined, 'lead', { assignee: worker.id });

    // Complete both (no review loop attached)
    manager.updateTaskStatus(team.id, task1.id, 'completed', worker.id);
    expect(synthesisEvents).toHaveLength(0); // Not yet â€” task2 still open

    manager.updateTaskStatus(team.id, task2.id, 'completed', worker.id);
    expect(synthesisEvents).toHaveLength(1);
    expect(synthesisEvents[0].completedTasks).toHaveLength(2);
  });

  it('cleans up team and releases all resources', async () => {
    const team = manager.createTeam({
      name: 'cleanup-team',
      leadSessionId: 'session-lead-3',
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

    manager.spawnTeammate({ teamId: team.id, name: 'worker', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });
    manager.createTask(team.id, 'Task 1', undefined, 'lead');

    await manager.cleanupTeam(team.id);

    expect(team.status).toBe('completed');
    expect(team.members).toHaveLength(0);
    expect(manager.getTasks(team.id)).toHaveLength(0);
    expect(manager.getMessages(team.id)).toHaveLength(0);
    expect(manager.getActivityLog(team.id)).toHaveLength(0);
  });
});

// ============================================================
// SCENARIO 2: Quality Gate Engine â€” Core Logic
// ============================================================

describe('Quality Gate Engine â€” Core Logic', () => {
  it('computes weighted aggregate score correctly', () => {
    const stages: Partial<Record<QualityGateStageName, QualityGateStageResult>> = {
      architecture: { score: 80, passed: true, issues: [], suggestions: [] },
      simplicity: { score: 90, passed: true, issues: [], suggestions: [] },
      errors: { score: 70, passed: true, issues: [], suggestions: [] },
      completeness: { score: 100, passed: true, issues: [], suggestions: [] },
    };

    // Weights: arch=25, simplicity=10, errors=25, completeness=25 => total=85
    // (80*25 + 90*10 + 70*25 + 100*25) / (25+10+25+25) = (2000+900+1750+2500)/85 = 7150/85 = 84.11 â†’ 84
    const score = computeAggregateScore(stages, DEFAULT_QUALITY_GATE_CONFIG.stages);
    expect(score).toBe(84);
  });

  it('excludes binary stages from weighted average', () => {
    const stages: Partial<Record<QualityGateStageName, QualityGateStageResult>> = {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [] },
      architecture: { score: 100, passed: true, issues: [], suggestions: [] },
    };

    // Binary stages (syntax, tests) have weight 0 and binary=true â€” excluded
    // Only architecture (weight=25) counted â†’ 100
    const score = computeAggregateScore(stages, DEFAULT_QUALITY_GATE_CONFIG.stages);
    expect(score).toBe(100);
  });

  it('passes when all binary gates pass and score meets threshold', () => {
    const result = createPassingResult({ aggregateScore: 92 });
    expect(shouldPass(result, DEFAULT_QUALITY_GATE_CONFIG)).toBe(true);
  });

  it('fails when a binary gate fails regardless of high score', () => {
    const result = createPassingResult({ aggregateScore: 95 });
    result.stages.syntax = { score: 0, passed: false, issues: ['TS error'], suggestions: [] };
    expect(shouldPass(result, DEFAULT_QUALITY_GATE_CONFIG)).toBe(false);
  });

  it('skips unexecuted SDD stages â€” the Bug #4 fix', () => {
    // SDD stages are enabled in default config but NOT present in result
    // (simulating no spec attached). Should NOT cause false failure.
    const result = createPassingResult({ aggregateScore: 92 });
    // Remove SDD stages from result to simulate "not executed"
    delete (result.stages as any).spec_compliance;
    delete (result.stages as any).traceability;
    delete (result.stages as any).rollout_safety;

    expect(shouldPass(result, DEFAULT_QUALITY_GATE_CONFIG)).toBe(true);
  });

  it('formats failure report with blocking issues first', () => {
    const result = createBinaryFailResult();
    result.cycleCount = 1;
    result.maxCycles = 5;

    const report = formatFailureReport(result, DEFAULT_QUALITY_GATE_CONFIG);

    expect(report).toContain('FAILED');
    expect(report).toContain('BLOCKING Issues');
    expect(report).toContain('Syntax & Types');
    expect(report).toContain('Test Execution');
    // BLOCKING section should appear before Issues to Address
    const blockingIdx = report.indexOf('BLOCKING');
    expect(blockingIdx).toBeGreaterThan(-1);
  });

  it('formats success report with phase scoreboard', () => {
    const result = createPassingResult();
    const report = formatSuccessReport(result);

    expect(report).toContain('PASSED');
    expect(report).toContain('Score: 92%');
    expect(report).toContain('### Phase Scoreboard');
    expect(report).toContain('- [PASS] Syntax & Types: 100% (PASS)');
    expect(report).toContain('Reviewer notes (non-blocking)');
  });

  it('merges user config over defaults preserving unset fields', () => {
    const merged = mergeQualityGateConfig({
      passThreshold: 85,
      stages: {
        syntax: { enabled: false, weight: 0, binary: true },
      } as any,
    });

    expect(merged.passThreshold).toBe(85);
    expect(merged.stages.syntax.enabled).toBe(false);
    // Other stages should retain defaults
    expect(merged.stages.tests.enabled).toBe(true);
    expect(merged.stages.architecture.weight).toBe(25);
  });

  it('clamps pass threshold to 70-95 range', () => {
    const tooLow = mergeQualityGateConfig({ passThreshold: 50 });
    expect(tooLow.passThreshold).toBe(70);

    const tooHigh = mergeQualityGateConfig({ passThreshold: 100 });
    expect(tooHigh.passThreshold).toBe(95);
  });

  it('infers review provider from model name', () => {
    const kimi = mergeQualityGateConfig({ reviewModel: 'kimi-k2.5' });
    expect(kimi.reviewProvider).toBe('moonshot');

    const claude = mergeQualityGateConfig({ reviewModel: 'claude-sonnet-4-5-20250929' });
    expect(claude.reviewProvider).toBe('anthropic');
  });
});

// ============================================================
// SCENARIO 3: Review Loop â€” Happy Path (Pass on First Cycle)
// ============================================================

describe('Review Loop â€” Happy Path', () => {
  it('intercepts task completion and routes to quality review', async () => {
    const { manager, callbacks } = createWiredSystem();
    const { team, workerA, tasks } = setupTeamWithTasks(manager);

    // Worker marks task completed â€” should be intercepted
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    // Task should be in_review, not completed
    const task = manager.getTasks(team.id).find(t => t.id === tasks[0]!.id);
    expect(task?.status).toBe('in_review');

    // Wait for async review to complete
    await vi.waitFor(() => {
      expect(callbacks.runQualityGates).toHaveBeenCalled();
    });
  });

  it('marks task completed after quality gates pass', async () => {
    const { manager, reviewLoop, events } = createWiredSystem();
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Worker completes task
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    // Wait for review to finish
    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(1);
    });

    // Task should now be truly completed
    const task = manager.getTasks(team.id).find(t => t.id === tasks[0]!.id);
    expect(task?.status).toBe('completed');
    expect(events['review:passed']![0]!.cycleNumber).toBe(1);
    expect(events['review:passed']![0]!.aggregateScore).toBe(92);
  });

  it('creates pre-review and post-pass checkpoints', async () => {
    const { manager, callbacks, events } = createWiredSystem();
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(1);
    });

    // Verify checkpoint calls
    expect(callbacks.createCheckpoint).toHaveBeenCalledTimes(2);

    const calls = (callbacks.createCheckpoint as any).mock.calls;
    expect(calls[0][3]).toBe('pre-review'); // first checkpoint
    expect(calls[1][3]).toBe('post-pass');  // second checkpoint
  });

  it('triggers synthesis after all gated tasks pass', async () => {
    const { manager, managerEvents, events } = createWiredSystem();
    const { team, workerA, workerB, tasks } = setupTeamWithTasks(manager, 2);

    // Complete task 1 (assigned to workerA)
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(1);
    });

    // Synthesis should NOT have fired yet
    expect(managerEvents['synthesis:requested']).toHaveLength(0);

    // Complete task 2 (assigned to workerB)
    manager.updateTaskStatus(team.id, tasks[1]!.id, 'completed', workerB.id);

    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(2);
    });

    // NOW synthesis should fire
    expect(managerEvents['synthesis:requested']).toHaveLength(1);
    expect(managerEvents['synthesis:requested']![0]!.completedTasks).toHaveLength(2);
  });
});

// ============================================================
// SCENARIO 4: Review Loop â€” Failure & Feedback Cycle
// ============================================================

describe('Review Loop â€” Failure & Feedback Cycle', () => {
  it('sends failure report and returns task to in_progress on fail', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:failed']).toHaveLength(1);
    });

    // Task should return to in_progress
    const task = manager.getTasks(team.id).find(t => t.id === tasks[0]!.id);
    expect(task?.status).toBe('in_progress');

    // Feedback should be sent
    expect(callbacks.sendFeedback).toHaveBeenCalledTimes(1);
    const feedbackCall = (callbacks.sendFeedback as any).mock.calls[0];
    expect(feedbackCall[0]).toBe(team.id);
    expect(feedbackCall[1]).toBe(workerA.id);
    expect(feedbackCall[2]).toContain('FAILED');
    expect(feedbackCall[2]).toContain('God class');
  });

  it('allows rework and passes on second cycle', async () => {
    let callCount = 0;
    const { manager, callbacks, events, reviewLoop } = createWiredSystem({
      callbackOverrides: {
        runQualityGates: vi.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1 ? createFailingResult() : createPassingResult();
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // First attempt â€” fails
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:failed']).toHaveLength(1);
    });

    expect(manager.getTasks(team.id).find(t => t.id === tasks[0]!.id)?.status).toBe('in_progress');

    // Second attempt â€” worker reworks and marks completed again
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(1);
    });

    // Task should now be completed
    const task = manager.getTasks(team.id).find(t => t.id === tasks[0]!.id);
    expect(task?.status).toBe('completed');
    expect(events['review:passed']![0]!.cycleNumber).toBe(2);

    // Quality report should show full cycle history
    const report = reviewLoop.getTaskQualityReport(tasks[0]!.id);
    expect(report).toBeDefined();
    expect(report!.cycleHistory).toHaveLength(2);
    expect(report!.cycleHistory[0]!.passed).toBe(false);
    expect(report!.cycleHistory[1]!.passed).toBe(true);
    expect(report!.disposition).toBe('passed');
  });

  it('tracks cycle history across multiple attempts', async () => {
    let callCount = 0;
    const { manager, events, reviewLoop } = createWiredSystem({
      callbackOverrides: {
        runQualityGates: vi.fn().mockImplementation(async () => {
          callCount++;
          return callCount <= 2 ? createFailingResult({ aggregateScore: 60 + callCount * 10 }) : createPassingResult();
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Cycle 1 â€” fail
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    // Cycle 2 â€” fail
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(2));

    // Cycle 3 â€” pass
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:passed']).toHaveLength(1));

    const report = reviewLoop.getTaskQualityReport(tasks[0]!.id);
    expect(report!.cycleHistory).toHaveLength(3);
    expect(report!.cycleHistory[0]!.aggregateScore).toBe(70);
    expect(report!.cycleHistory[1]!.aggregateScore).toBe(80);
    expect(report!.cycleHistory[2]!.passed).toBe(true);
  });

  it('handles diff collection errors gracefully', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      callbackOverrides: {
        collectDiff: vi.fn().mockRejectedValue(new Error('git diff failed: not a repository')),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:error']).toHaveLength(1);
    });

    expect(events['review:error']![0]!.error).toContain('Failed to collect diff');
    expect(callbacks.sendFeedback).toHaveBeenCalled();
    const feedback = (callbacks.sendFeedback as any).mock.calls[0][2];
    expect(feedback).toContain('ERROR');
    expect(feedback).toContain('git diff failed');
  });

  it('handles empty diff gracefully', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      callbackOverrides: {
        collectDiff: vi.fn().mockResolvedValue(''),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:error']).toHaveLength(1);
    });

    expect(events['review:error']![0]!.error).toContain('No diff found');
    expect(callbacks.sendFeedback).toHaveBeenCalled();
    const feedback = (callbacks.sendFeedback as any).mock.calls[0][2];
    expect(feedback).toContain('NO CHANGES DETECTED');
  });
});

// ============================================================
// SCENARIO 5: Review Loop â€” Escalation
// ============================================================

describe('Review Loop â€” Escalation', () => {
  it('escalates after maxReviewCycles failures', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      maxCycles: 2,
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Cycle 1 â€” fail
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    // Cycle 2 â€” fail and escalate
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:escalated']).toHaveLength(1));

    expect(callbacks.escalate).toHaveBeenCalledTimes(1);
    expect(events['review:escalated']![0]!.cycleNumber).toBe(2);
    expect(events['review:escalated']![0]!.escalationReport).toContain('dependency injection');
  });

  it('returns task to in_progress after escalation for final attempt', async () => {
    const { manager, events } = createWiredSystem({
      maxCycles: 1,
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:escalated']).toHaveLength(1));

    // Task should be back in in_progress (one more chance with escalation advice)
    const task = manager.getTasks(team.id).find(t => t.id === tasks[0]!.id);
    expect(task?.status).toBe('in_progress');
  });

  it('includes escalation warning in penultimate cycle failure report', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      maxCycles: 3,
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Cycle 1
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    // Cycle 2 (penultimate) â€” should warn about approaching max
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(2));

    const feedback = (callbacks.sendFeedback as any).mock.calls[1][2];
    expect(feedback).toContain('Warning');
    expect(feedback).toContain('cycle 2/3');
  });

  it('handles escalation callback failure gracefully', async () => {
    const { manager, callbacks, events } = createWiredSystem({
      maxCycles: 1,
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
        escalate: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:escalated']).toHaveLength(1));

    // Should fallback to default message
    const feedback = (callbacks.sendFeedback as any).mock.calls[0][2];
    expect(feedback).toContain('ESCALATED');
    expect(feedback).toContain('manual review required');
  });
});

// ============================================================
// SCENARIO 6: Health Monitor Integration
// ============================================================

describe('Health Monitor Integration', () => {
  let monitor: TeammateHealthMonitor;

  beforeEach(() => {
    monitor = new TeammateHealthMonitor({
      stallTimeoutMs: 100,
      errorLoopThreshold: 3,
      retryStormThreshold: 5,
      checkIntervalMs: 50,
      contextWarningThreshold: 0.85,
    });
  });

  afterEach(() => {
    monitor.dispose();
  });

  it('detects stalled teammate with no activity', async () => {
    const issues: any[] = [];
    monitor.on('health:stall', (issue) => issues.push(issue));

    monitor.startMonitoring('team-1');
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
      type: 'task_update',
      taskId: 'task-1',
    });

    // Wait for stall timeout + check interval
    await new Promise(r => setTimeout(r, 200));

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('stall');
    expect(issues[0].teammateId).toBe('mate-1');
    expect(issues[0].taskId).toBe('task-1');
  });

  it('detects error loop on consecutive tool failures', () => {
    const issues: any[] = [];
    monitor.on('health:error-loop', (issue) => issues.push(issue));

    monitor.startMonitoring('team-1');

    // Record 3 consecutive errors on the same tool
    for (let i = 0; i < 3; i++) {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_result',
        toolName: 'Write',
        error: true,
      });
    }

    // Manually trigger health check (normally interval-based)
    (monitor as any).checkHealth('team-1');

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('error-loop');
    expect(issues[0].details).toContain('3 consecutive errors');
    expect(issues[0].details).toContain('Write');
  });

  it('detects retry storm on repeated similar tool calls', () => {
    const issues: any[] = [];
    monitor.on('health:retry-storm', (issue) => issues.push(issue));

    monitor.startMonitoring('team-1');

    // Record 5 identical tool calls
    for (let i = 0; i < 5; i++) {
      monitor.recordActivity('team-1', 'mate-1', 'Worker A', {
        type: 'tool_call',
        toolName: 'Read',
        toolInput: '/src/app.ts',
      });
    }

    (monitor as any).checkHealth('team-1');

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('retry-storm');
    expect(issues[0].details).toContain('5 similar calls to "Read"');
  });

  it('detects context exhaustion above threshold', () => {
    const issues: any[] = [];
    monitor.on('health:context-exhaustion', (issue) => issues.push(issue));

    monitor.startMonitoring('team-1');
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', { type: 'tool_call', toolName: 'Read' });
    monitor.recordContextUsage('team-1', 'mate-1', 0.90);

    (monitor as any).checkHealth('team-1');

    expect(issues).toHaveLength(1);
    expect(issues[0].type).toBe('context-exhaustion');
    expect(issues[0].details).toContain('90%');
  });

  it('resets error counter on successful tool result', () => {
    monitor.startMonitoring('team-1');

    // 2 errors
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', { type: 'tool_result', toolName: 'Write', error: true });
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', { type: 'tool_result', toolName: 'Write', error: true });

    // 1 success â€” should reset
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', { type: 'tool_result', toolName: 'Write', error: false });

    // 1 more error
    monitor.recordActivity('team-1', 'mate-1', 'Worker A', { type: 'tool_result', toolName: 'Write', error: true });

    const health = monitor.getHealth('team-1', 'mate-1');
    expect(health?.consecutiveErrors).toBe(1); // Not 3
  });
});

// ============================================================
// SCENARIO 7: File Ownership & Conflict Detection
// ============================================================

describe('File Ownership & Conflict Detection', () => {
  it('establishes ownership on first modification', () => {
    const tracker = new FileOwnershipTracker();

    const conflict = tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts', 'task-1');

    expect(conflict).toBeNull();
    const ownership = tracker.getOwnership('team-1', '/src/app.ts');
    expect(ownership).not.toBeNull();
    expect(ownership!.ownerId).toBe('mate-a');
    expect(ownership!.ownerName).toBe('Worker A');
    expect(ownership!.modificationCount).toBe(1);

    tracker.dispose();
  });

  it('detects conflict when second teammate modifies same file (warn mode)', () => {
    const tracker = new FileOwnershipTracker({ mode: 'warn' });
    const conflicts: any[] = [];
    tracker.on('file:conflict', (c) => conflicts.push(c));

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts', 'task-1');
    const conflict = tracker.recordModification('team-1', 'mate-b', 'Worker B', '/src/app.ts', 'task-2');

    expect(conflict).not.toBeNull();
    expect(conflict!.blocked).toBe(false); // warn mode
    expect(conflict!.currentOwner.ownerId).toBe('mate-a');
    expect(conflict!.attemptedBy.teammateId).toBe('mate-b');
    expect(conflicts).toHaveLength(1);

    tracker.dispose();
  });

  it('blocks modification in strict mode', () => {
    const tracker = new FileOwnershipTracker({ mode: 'strict' });

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts');
    const conflict = tracker.recordModification('team-1', 'mate-b', 'Worker B', '/src/app.ts');

    expect(conflict).not.toBeNull();
    expect(conflict!.blocked).toBe(true); // strict mode

    tracker.dispose();
  });

  it('allows same teammate to re-modify owned file', () => {
    const tracker = new FileOwnershipTracker();

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts');
    const conflict = tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts');

    expect(conflict).toBeNull();
    const ownership = tracker.getOwnership('team-1', '/src/app.ts');
    expect(ownership!.modificationCount).toBe(2);

    tracker.dispose();
  });

  it('releases ownership when task passes quality gates', () => {
    const tracker = new FileOwnershipTracker();

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts');
    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/utils.ts');

    // Simulate quality gate pass â†’ release files
    tracker.releaseOwnership('team-1', ['/src/app.ts', '/src/utils.ts']);

    // Now Worker B should be able to modify without conflict
    const conflict = tracker.recordModification('team-1', 'mate-b', 'Worker B', '/src/app.ts');
    expect(conflict).toBeNull();
    expect(tracker.getOwnership('team-1', '/src/app.ts')!.ownerId).toBe('mate-b');

    tracker.dispose();
  });

  it('releases all files on teammate shutdown', () => {
    const tracker = new FileOwnershipTracker();

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/a.ts');
    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/b.ts');
    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/c.ts');

    tracker.releaseTeammateFiles('team-1', 'mate-a');

    expect(tracker.getTeammateFiles('team-1', 'mate-a')).toHaveLength(0);

    tracker.dispose();
  });

  it('pre-checks conflict without recording it', () => {
    const tracker = new FileOwnershipTracker();

    tracker.recordModification('team-1', 'mate-a', 'Worker A', '/src/app.ts');

    // Pre-check should return conflict info
    const preCheck = tracker.checkConflict('team-1', '/src/app.ts', 'mate-b');
    expect(preCheck).not.toBeNull();
    expect(preCheck!.currentOwner.ownerId).toBe('mate-a');

    // But it should NOT be stored in the conflicts list
    expect(tracker.getConflicts('team-1')).toHaveLength(0);

    tracker.dispose();
  });
});

// ============================================================
// SCENARIO 8: Integration Gate â€” Post-Synthesis Verification
// ============================================================

describe('Integration Gate â€” Result Validation', () => {
  it('identifies integration pass when all checks succeed', () => {
    const result = {
      passed: true,
      typeCheck: { passed: true, errorCount: 0, errors: [] },
      testSuite: { passed: true, total: 42, passed_count: 42, failed: 0, skipped: 0, failedTests: [] },
      conflicts: { hasConflicts: false, conflictFiles: [] },
      brokenBy: [],
      timestamp: new Date().toISOString(),
      durationMs: 5200,
    };

    expect(result.passed).toBe(true);
    expect(result.typeCheck.passed).toBe(true);
    expect(result.testSuite.total).toBe(42);
    expect(result.conflicts.hasConflicts).toBe(false);
    expect(result.brokenBy).toHaveLength(0);
  });

  it('identifies integration failure when type check fails', () => {
    const result = {
      passed: false,
      typeCheck: { passed: false, errorCount: 3, errors: ['error TS2304: Cannot find name "foo"'] },
      testSuite: { passed: false, total: 0, passed_count: 0, failed: 0, skipped: 0, failedTests: ['Skipped â€” type check failed'] },
      conflicts: { hasConflicts: false, conflictFiles: [] },
      brokenBy: ['Worker A'],
      timestamp: new Date().toISOString(),
      durationMs: 1200,
    };

    expect(result.passed).toBe(false);
    expect(result.typeCheck.errorCount).toBe(3);
    expect(result.testSuite.failedTests[0]).toContain('Skipped');
    expect(result.brokenBy).toContain('Worker A');
  });

  it('identifies integration failure on git conflicts', () => {
    const result = {
      passed: false,
      typeCheck: { passed: true, errorCount: 0, errors: [] },
      testSuite: { passed: true, total: 42, passed_count: 42, failed: 0, skipped: 0, failedTests: [] },
      conflicts: { hasConflicts: true, conflictFiles: ['src/app.ts', 'src/router.ts'] },
      brokenBy: [],
      timestamp: new Date().toISOString(),
      durationMs: 4800,
    };

    expect(result.passed).toBe(false);
    expect(result.conflicts.hasConflicts).toBe(true);
    expect(result.conflicts.conflictFiles).toHaveLength(2);
  });
});

// ============================================================
// SCENARIO 9: Audit Trail
// ============================================================

describe('Audit Trail', () => {
  it('logs review-cycle-started on each cycle via callback', async () => {
    const auditEntries: any[] = [];
    const { manager, events } = createWiredSystem({
      maxCycles: 3,
      callbackOverrides: {
        runQualityGates: vi.fn()
          .mockResolvedValueOnce(createFailingResult())
          .mockResolvedValueOnce(createPassingResult()),
        auditLog: vi.fn().mockImplementation(async (entry) => {
          auditEntries.push(entry);
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Cycle 1 â€” fail
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    // Cycle 2 â€” pass
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:passed']).toHaveLength(1));

    const startedEntries = auditEntries.filter(e => e.type === 'review-cycle-started');
    expect(startedEntries).toHaveLength(2);
    expect(startedEntries[0].cycleNumber).toBe(1);
    expect(startedEntries[1].cycleNumber).toBe(2);
  });

  it('logs quality-gate-completed with pass/fail data', async () => {
    const auditEntries: any[] = [];
    const { manager, events } = createWiredSystem({
      callbackOverrides: {
        runQualityGates: vi.fn()
          .mockResolvedValueOnce(createFailingResult())
          .mockResolvedValueOnce(createPassingResult()),
        auditLog: vi.fn().mockImplementation(async (entry) => {
          auditEntries.push(entry);
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    // Cycle 1 â€” fail
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    // Cycle 2 â€” pass
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:passed']).toHaveLength(1));

    const gateEntries = auditEntries.filter(e => e.type === 'quality-gate-completed');
    expect(gateEntries).toHaveLength(2);

    // First gate: failed
    expect(gateEntries[0].data.passed).toBe(false);
    expect(gateEntries[0].data.aggregateScore).toBe(65);

    // Second gate: passed
    expect(gateEntries[1].data.passed).toBe(true);
    expect(gateEntries[1].data.aggregateScore).toBe(92);
  });

  it('logs feedback-sent entries', async () => {
    const auditEntries: any[] = [];
    const { manager, events } = createWiredSystem({
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
        auditLog: vi.fn().mockImplementation(async (entry) => {
          auditEntries.push(entry);
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    const feedbackEntries = auditEntries.filter(e => e.type === 'feedback-sent');
    expect(feedbackEntries).toHaveLength(1);
    expect(feedbackEntries[0].data.reportLength).toBeGreaterThan(0);
  });

  it('logs escalation events', async () => {
    const auditEntries: any[] = [];
    const { manager, events } = createWiredSystem({
      maxCycles: 1,
      callbackOverrides: {
        runQualityGates: vi.fn().mockResolvedValue(createFailingResult()),
        auditLog: vi.fn().mockImplementation(async (entry) => {
          auditEntries.push(entry);
        }),
      },
    });
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    await vi.waitFor(() => expect(events['review:escalated']).toHaveLength(1));

    const escalationTriggered = auditEntries.filter(e => e.type === 'escalation-triggered');
    const escalationCompleted = auditEntries.filter(e => e.type === 'escalation-completed');

    expect(escalationTriggered).toHaveLength(1);
    expect(escalationCompleted).toHaveLength(1);
    expect(escalationCompleted[0].data.escalationReport).toBeDefined();
  });
});

// ============================================================
// SCENARIO 10: Full E2E Orchestration â€” Lead Handoff to Workers
// ============================================================

describe('Full E2E Orchestration â€” Lead Handoff to Workers', () => {
  it('executes full lead â†’ worker â†’ review â†’ pass â†’ synthesis pipeline', async () => {
    const auditEntries: any[] = [];
    let workerACallCount = 0;

    // Worker A: passes first time. Worker B: fails once then passes.
    const { manager, reviewLoop, callbacks, events, managerEvents } = createWiredSystem({
      maxCycles: 5,
      callbackOverrides: {
        runQualityGates: vi.fn().mockImplementation(async (_diff, taskDesc) => {
          if (taskDesc.includes('feature A') || taskDesc.includes('feature C')) {
            return createPassingResult();
          }
          // Feature B (Worker B): fail first, then pass
          workerACallCount++;
          return workerACallCount <= 1
            ? createFailingResult({ aggregateScore: 72 })
            : createPassingResult({ aggregateScore: 91 });
        }),
        auditLog: vi.fn().mockImplementation(async (entry) => {
          auditEntries.push(entry);
        }),
      },
    });

    // 1. Create team with lead + 2 workers
    const team = manager.createTeam({
      name: 'e2e-team',
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

    const workerA = manager.spawnTeammate({ teamId: team.id, name: 'worker-a', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });
    const workerB = manager.spawnTeammate({ teamId: team.id, name: 'worker-b', role: 'worker', model: 'kimi-k2.5', provider: 'moonshot' });

    // 2. Lead creates tasks and assigns them
    const task1 = manager.createTask(team.id, 'Implement feature A', 'Build feature A module', 'lead', { assignee: workerA.id });
    const task2 = manager.createTask(team.id, 'Implement feature B', 'Build feature B module', 'lead', { assignee: workerB.id });
    const task3 = manager.createTask(team.id, 'Implement feature C', 'Build feature C module', 'lead', { assignee: workerA.id });

    manager.updateTaskStatus(team.id, task1.id, 'in_progress', workerA.id);
    manager.updateTaskStatus(team.id, task2.id, 'in_progress', workerB.id);
    manager.updateTaskStatus(team.id, task3.id, 'in_progress', workerA.id);

    // 3. Track file ownership
    const fileTracker = new FileOwnershipTracker();
    fileTracker.recordModification(team.id, workerA.id, 'worker-a', '/src/featureA.ts', task1.id);
    fileTracker.recordModification(team.id, workerB.id, 'worker-b', '/src/featureB.ts', task2.id);

    // File conflict: Worker B also touches a file Worker A owns
    const conflict = fileTracker.recordModification(team.id, workerB.id, 'worker-b', '/src/featureA.ts', task2.id);
    expect(conflict).not.toBeNull();
    expect(conflict!.currentOwner.ownerId).toBe(workerA.id);

    // 4. Start health monitoring
    const healthMonitor = new TeammateHealthMonitor({ stallTimeoutMs: 5000, checkIntervalMs: 10000 });
    healthMonitor.startMonitoring(team.id);
    healthMonitor.recordActivity(team.id, workerA.id, 'worker-a', { type: 'tool_call', toolName: 'Edit' });
    healthMonitor.recordActivity(team.id, workerB.id, 'worker-b', { type: 'tool_call', toolName: 'Write' });

    // 5. Worker A completes task 1 â†’ passes quality gates
    manager.updateTaskStatus(team.id, task1.id, 'completed', workerA.id);
    await vi.waitFor(() => expect((events['review:passed'] ?? []).length).toBeGreaterThanOrEqual(1));

    const task1State = manager.getTasks(team.id).find(t => t.id === task1.id);
    expect(task1State?.status).toBe('completed');

    // 6. Worker B completes task 2 â†’ FAILS quality gates first time
    manager.updateTaskStatus(team.id, task2.id, 'completed', workerB.id);
    await vi.waitFor(() => expect(events['review:failed']).toHaveLength(1));

    expect(manager.getTasks(team.id).find(t => t.id === task2.id)?.status).toBe('in_progress');

    // Worker B reworks and tries again â†’ PASSES
    manager.updateTaskStatus(team.id, task2.id, 'completed', workerB.id);
    await vi.waitFor(() => expect((events['review:passed'] ?? []).length).toBeGreaterThanOrEqual(2));

    expect(manager.getTasks(team.id).find(t => t.id === task2.id)?.status).toBe('completed');

    // Synthesis should NOT fire yet â€” task 3 still open
    expect(managerEvents['synthesis:requested']).toHaveLength(0);

    // 7. Worker A completes task 3 â†’ passes
    manager.updateTaskStatus(team.id, task3.id, 'completed', workerA.id);
    await vi.waitFor(() => expect((events['review:passed'] ?? []).length).toBeGreaterThanOrEqual(3));

    // 8. ALL tasks done â†’ synthesis fires
    expect(managerEvents['synthesis:requested']).toHaveLength(1);
    expect(managerEvents['synthesis:requested']![0]!.completedTasks).toHaveLength(3);

    // 9. Verify audit trail captured everything
    const auditTypes = auditEntries.map(e => e.type);
    expect(auditTypes).toContain('review-cycle-started');
    expect(auditTypes).toContain('quality-gate-completed');
    expect(auditTypes).toContain('feedback-sent'); // From the Worker B failure

    // Quality report for task 2 should show 2 cycles
    const task2Report = reviewLoop.getTaskQualityReport(task2.id);
    expect(task2Report!.cycleHistory).toHaveLength(2);
    expect(task2Report!.cycleHistory[0]!.passed).toBe(false);
    expect(task2Report!.cycleHistory[1]!.passed).toBe(true);

    // 10. Cost tracking
    manager.updateTeammateUsage(team.id, workerA.id, { inputTokens: 50000, outputTokens: 15000, costUsd: 0.08 });
    manager.updateTeammateUsage(team.id, workerB.id, { inputTokens: 80000, outputTokens: 25000, costUsd: 0.15 });

    const cost = manager.getCostSummary(team.id);
    expect(cost.totalCostUsd).toBeCloseTo(0.23, 2);
    expect(cost.perTeammate[workerA.id]!.inputTokens).toBe(50000);
    expect(cost.perTeammate[workerB.id]!.costUsd).toBe(0.15);
    expect(cost.perModel['kimi-k2.5']!.inputTokens).toBe(130000);

    // Cleanup
    healthMonitor.dispose();
    fileTracker.dispose();
  });

  it('handles concurrent task completions without race conditions', async () => {
    const { manager, events } = createWiredSystem();
    const { team, workerA, workerB, tasks } = setupTeamWithTasks(manager, 2);

    // Both workers complete tasks simultaneously
    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);
    manager.updateTaskStatus(team.id, tasks[1]!.id, 'completed', workerB.id);

    // Both should eventually pass (quality gates mock returns passing by default)
    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(2);
    });

    // Both tasks should be completed
    const finalTasks = manager.getTasks(team.id);
    expect(finalTasks.every(t => t.status === 'completed')).toBe(true);
  });

  it('activity log captures correct event sequence', async () => {
    const { manager, managerEvents, events } = createWiredSystem();
    const { team, workerA, tasks } = setupTeamWithTasks(manager, 1);

    manager.updateTaskStatus(team.id, tasks[0]!.id, 'completed', workerA.id);

    await vi.waitFor(() => {
      expect(events['review:passed']).toHaveLength(1);
    });

    const activityLog = managerEvents['activity'] ?? [];
    const activityTypes = activityLog.map((e: any) => e.type);

    // Should contain the sequence: task-in-review â†’ task-completed
    expect(activityTypes).toContain('task-in-review');
    expect(activityTypes).toContain('task-completed');

    // in_review should come before completed
    const reviewIdx = activityTypes.indexOf('task-in-review');
    const completedIdx = activityTypes.lastIndexOf('task-completed');
    expect(reviewIdx).toBeLessThan(completedIdx);
  });
});

