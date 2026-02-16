import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { YoloOrchestrator, mergeYoloConfig } from './yolo-orchestrator';

function makeSpec() {
  return {
    id: 'spec-1',
    title: 'Spec',
    objective: 'Objective',
    requirements: [],
    createdAt: new Date('2026-02-13T10:25:00.000Z').toISOString(),
    updatedAt: new Date('2026-02-13T10:25:00.000Z').toISOString(),
  } as any;
}

function createHarness() {
  const tasks: any[] = [];
  const activity: Array<{ type: string; details: string }> = [];

  const teamManager = {
    setTeamSpec: () => {},
    getTeamSpec: () => makeSpec(),
    createTask: (_teamId: string, title: string, description: string) => {
      const task = {
        id: `task-${tasks.length + 1}`,
        title,
        description,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      tasks.push(task);
      return task;
    },
    getTasks: () => tasks,
    getCostSummary: () => ({ totalCostUsd: 0, perTeammate: {}, perModel: {} }),
    logActivity: (_teamId: string, type: string, details: string) => {
      activity.push({ type, details });
    },
  } as any;

  const reviewLoop = new EventEmitter() as any;

  const spawnBatches: string[][] = [];
  const phaseChanges: string[] = [];

  const callbacks = {
    generateSpec: async () => makeSpec(),
    decomposeIntoTasks: async () => [
      { title: 'Task A', description: 'A', phase: 'phase-2', phaseOrder: 2 },
      { title: 'Task B', description: 'B', phase: 'phase-1', phaseOrder: 1 },
    ],
    spawnAndAssign: async (_teamId: string, taskIds: string[]) => {
      spawnBatches.push(taskIds);
      for (const id of taskIds) {
        const t = tasks.find(x => x.id === id);
        if (t) t.status = 'completed';
      }
    },
    runIntegrationCheck: async () => ({ passed: true, issues: [] as string[] }),
    synthesize: async () => 'done',
    onStateChange: (_teamId: string, state: any) => {
      phaseChanges.push(state.phase);
    },
  };

  return { teamManager, reviewLoop, callbacks, spawnBatches, phaseChanges, activity };
}

describe('mergeYoloConfig', () => {
  it('applies overrides on top of defaults', () => {
    const merged = mergeYoloConfig({ mode: 'smart', maxConcurrency: 7 });
    expect(merged.mode).toBe('smart');
    expect(merged.maxConcurrency).toBe(7);
    expect(merged.costCapUsd).toBe(5);
  });
});

describe('YoloOrchestrator', { timeout: 30_000 }, () => {
  it('executes phased tasks in phase order and completes', async () => {
    const h = createHarness();
    const orchestrator = new YoloOrchestrator(h.teamManager, h.reviewLoop, h.callbacks);

    const state = await orchestrator.start('team-1', 'Ship feature', {
      mode: 'fixed',
      maxConcurrency: 1,
      timeoutMinutes: 1,
      costCapUsd: 100,
    });

    expect(state.phase).toBe('completed');
    expect(state.summary).toBe('done');

    // phase-1 task should run before phase-2 task
    expect(h.spawnBatches).toEqual([['task-2'], ['task-1']]);

    expect(h.phaseChanges).toContain('spec-generation');
    expect(h.phaseChanges).toContain('integration-check');
    expect(h.phaseChanges[h.phaseChanges.length - 1]).toBe('completed');

    expect(h.activity.some(a => a.type === 'yolo-started')).toBe(true);
    expect(h.activity.some(a => a.type === 'phase-advanced')).toBe(true);
    expect(h.activity.some(a => a.type === 'yolo-completed')).toBe(true);
  });
});
