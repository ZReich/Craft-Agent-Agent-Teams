import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgentTeamManager } from '../agent-team-manager';

function createManagerWithTeam(workspaceRootPath: string) {
  const manager = new AgentTeamManager();
  const team = manager.createTeam({
    name: 'contracts-team',
    leadSessionId: 'lead-session',
    workspaceRootPath,
    modelConfig: {
      defaults: {
        lead: { model: 'test', provider: 'test' },
        head: { model: 'test', provider: 'test' },
        worker: { model: 'test', provider: 'test' },
        reviewer: { model: 'test', provider: 'test' },
        escalation: { model: 'test', provider: 'test' },
      },
    },
  });
  return { manager, team };
}

describe('AgentTeamManager completion contracts', () => {
  it('fails completion when required artifact is missing, then passes after artifact exists', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-team-contracts-'));
    const { manager, team } = createManagerWithTeam(workspaceRoot);

    const task = manager.createTask(
      team.id,
      'Publish cuisine findings',
      'Create findings and evidence artifacts',
      'lead',
      {
        taskType: 'research',
        requiredArtifacts: [
          'docs/analysis/team-lead-cuisine-findings.md',
          'docs/analysis/team-lead-cuisine-evidence.json',
        ],
      },
    );

    manager.updateTaskStatus(team.id, task.id, 'in_progress', 'worker-1');
    manager.updateTaskStatus(team.id, task.id, 'completed', 'worker-1');

    let stored = manager.getTasks(team.id).find((t) => t.id === task.id);
    expect(stored?.status).toBe('failed');

    const findingsPath = join(workspaceRoot, 'docs/analysis/team-lead-cuisine-findings.md');
    const evidencePath = join(workspaceRoot, 'docs/analysis/team-lead-cuisine-evidence.json');
    mkdirSync(dirname(findingsPath), { recursive: true });
    writeFileSync(findingsPath, '# Findings\n', 'utf8');
    writeFileSync(evidencePath, '{"rows":[]}', 'utf8');

    manager.updateTaskStatus(team.id, task.id, 'in_progress', 'worker-1');
    manager.updateTaskStatus(team.id, task.id, 'completed', 'worker-1');

    stored = manager.getTasks(team.id).find((t) => t.id === task.id);
    expect(stored?.status).toBe('completed');
  });

  it('allows empty artifact files when requireNonEmptyArtifacts=false', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'agent-team-contracts-'));
    const { manager, team } = createManagerWithTeam(workspaceRoot);

    const task = manager.createTask(
      team.id,
      'Write marker file',
      'Marker-only artifact contract',
      'lead',
      {
        requiredArtifacts: ['docs/analysis/marker.txt'],
        requireNonEmptyArtifacts: false,
      },
    );

    const markerPath = join(workspaceRoot, 'docs/analysis/marker.txt');
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(markerPath, '', 'utf8');

    manager.updateTaskStatus(team.id, task.id, 'in_progress', 'worker-1');
    manager.updateTaskStatus(team.id, task.id, 'completed', 'worker-1');

    const stored = manager.getTasks(team.id).find((t) => t.id === task.id);
    expect(stored?.status).toBe('completed');
  });
});
