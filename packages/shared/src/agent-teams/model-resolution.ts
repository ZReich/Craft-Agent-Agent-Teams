/**
 * Agent Teams Model Resolution
 *
 * Resolves team model presets and per-role overrides from workspace config.
 * Used by team creation and teammate spawn logic to enforce selected models.
 */

import type { TeamModelConfig, TeamRole, ModelAssignment, ModelPresetId } from '@craft-agent/core/types';
import type { WorkspaceConfig } from '../workspaces/types.ts';
import { getDefaultPreset, getPreset } from '../providers/presets.ts';
import { inferProviderFromModel } from '../usage/index.ts';

export interface ResolvedTeamModelConfig {
  presetId: ModelPresetId;
  modelConfig: TeamModelConfig;
}

const ROLE_MODEL_KEYS: Record<TeamRole, keyof NonNullable<WorkspaceConfig['agentTeams']>> = {
  lead: 'leadModel',
  head: 'headModel',
  worker: 'workerModel',
  reviewer: 'reviewerModel',
  escalation: 'escalationModel',
};

function applyRoleOverride(modelConfig: TeamModelConfig, role: TeamRole, model?: string): void {
  if (!model) return;
  modelConfig.defaults[role] = {
    model,
    provider: inferProviderFromModel(model),
  };
}

export function resolveTeamModelConfig(
  workspaceConfig: WorkspaceConfig | null | undefined,
  presetOverride?: ModelPresetId,
): ResolvedTeamModelConfig {
  const configuredPreset = workspaceConfig?.agentTeams?.modelPreset as ModelPresetId | undefined;
  const requestedPreset = presetOverride ?? configuredPreset;
  const basePreset = (requestedPreset ? getPreset(requestedPreset) : undefined) ?? getDefaultPreset();

  const modelConfig: TeamModelConfig = {
    defaults: {
      lead: { ...basePreset.config.defaults.lead },
      head: { ...basePreset.config.defaults.head },
      worker: { ...basePreset.config.defaults.worker },
      reviewer: { ...basePreset.config.defaults.reviewer },
      escalation: { ...basePreset.config.defaults.escalation },
    },
  };

  const agentTeams = workspaceConfig?.agentTeams;
  if (agentTeams) {
    applyRoleOverride(modelConfig, 'lead', agentTeams.leadModel);
    applyRoleOverride(modelConfig, 'head', agentTeams.headModel);
    applyRoleOverride(modelConfig, 'worker', agentTeams.workerModel);
    applyRoleOverride(modelConfig, 'reviewer', agentTeams.reviewerModel);
    applyRoleOverride(modelConfig, 'escalation', agentTeams.escalationModel);
  }

  return {
    presetId: basePreset.id,
    modelConfig,
  };
}

export function resolveTeamModelForRole(
  workspaceConfig: WorkspaceConfig | null | undefined,
  role: TeamRole,
  presetOverride?: ModelPresetId,
  fallbackModel?: string,
): ModelAssignment {
  const { modelConfig } = resolveTeamModelConfig(workspaceConfig, presetOverride);
  const assignment = modelConfig.defaults[role];
  if (assignment?.model) return assignment;
  if (fallbackModel) {
    return {
      model: fallbackModel,
      provider: inferProviderFromModel(fallbackModel),
    };
  }
  return {
    model: 'unknown',
    provider: 'unknown',
  };
}
