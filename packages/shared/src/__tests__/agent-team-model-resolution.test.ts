import { describe, it, expect } from 'bun:test';
import { resolveTeamModelConfig, resolveTeamModelForRole } from '../agent-teams/model-resolution.ts';
import type { WorkspaceConfig } from '../workspaces/types.ts';

describe('agent team model resolution', () => {
  it('uses workspace role overrides for worker', () => {
    const workspaceConfig: WorkspaceConfig = {
      id: 'ws-test',
      name: 'Test Workspace',
      slug: 'test-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentTeams: {
        enabled: true,
        modelPreset: 'balanced',
        workerModel: 'kimi-k2.5',
      },
    };

    const assignment = resolveTeamModelForRole(workspaceConfig, 'worker');
    expect(assignment.model).toBe('kimi-k2.5');
    expect(assignment.provider).toBe('moonshot');
  });

  it('falls back to preset defaults when no overrides', () => {
    const workspaceConfig: WorkspaceConfig = {
      id: 'ws-test',
      name: 'Test Workspace',
      slug: 'test-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      agentTeams: {
        enabled: true,
        modelPreset: 'balanced',
      },
    };

    const resolved = resolveTeamModelConfig(workspaceConfig);
    expect(resolved.presetId).toBe('balanced');
    expect(resolved.modelConfig.defaults.worker.model).toBe('claude-sonnet-4-5-20250929');
  });
});
