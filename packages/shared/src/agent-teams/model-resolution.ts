/**
 * Agent Teams Model Resolution
 *
 * Resolves team model presets and per-role overrides from workspace config.
 * Used by team creation and teammate spawn logic to enforce selected models.
 */

import type { TeamModelConfig, TeamRole, ModelAssignment, ModelPresetId } from '@craft-agent/core/types';
import { normalizeTeamRole } from '@craft-agent/core/types';
import type { WorkspaceConfig } from '../workspaces/types.ts';
import { getDefaultPreset, getPreset } from '../providers/presets.ts';
import { inferProviderFromModel } from '../usage/index.ts';

/** The 5 canonical role keys that exist in TeamModelConfig.defaults */
type CanonicalRole = 'lead' | 'head' | 'worker' | 'reviewer' | 'escalation';

/** Map any TeamRole (including new aliases) to a canonical config key */
function toCanonicalRole(role: TeamRole): CanonicalRole {
  const normalized = normalizeTeamRole(role);
  if (normalized === 'orchestrator') return 'lead';
  if (normalized === 'team-manager') return 'head';
  return normalized as CanonicalRole;
}

export interface ResolvedTeamModelConfig {
  presetId: ModelPresetId;
  modelConfig: TeamModelConfig;
}

// Implements REQ-B7: Map both old and new role names to config keys.
// 'orchestrator' maps to 'leadModel', 'team-manager' maps to 'headModel'.
const ROLE_MODEL_KEYS: Record<TeamRole, keyof NonNullable<WorkspaceConfig['agentTeams']>> = {
  lead: 'leadModel',
  orchestrator: 'leadModel',
  head: 'headModel',
  'team-manager': 'headModel',
  worker: 'workerModel',
  reviewer: 'reviewerModel',
  escalation: 'escalationModel',
};

function applyRoleOverride(modelConfig: TeamModelConfig, role: TeamRole, model?: string): void {
  if (!model) return;
  modelConfig.defaults[toCanonicalRole(role)] = {
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

/** Extract the preset ID from workspace config, checking both config shapes */
function resolvePresetId(wsConfig: WorkspaceConfig | null | undefined): string | undefined {
  return (wsConfig as any)?.settings?.agentTeamsModelPreset
    ?? wsConfig?.agentTeams?.modelPreset as string | undefined
}

export function resolveTeamModelForRole(
  workspaceConfig: WorkspaceConfig | null | undefined,
  role: TeamRole,
  presetOverride?: ModelPresetId,
  fallbackModel?: string,
  options?: { qgEnabled?: boolean },
): ModelAssignment {
  // Implements REQ-P2: QG-aware worker model selection
  // Smart strategy: Workers get Sonnet when QG catches errors, Opus when no safety net
  if (role === 'worker' || toCanonicalRole(role) === 'worker') {
    const effectivePreset = presetOverride ?? resolvePresetId(workspaceConfig)
    if (effectivePreset === 'smart' && options?.qgEnabled !== undefined) {
      const model = options.qgEnabled
        ? 'claude-sonnet-4-5-20250929'  // QG on: fast/cheap, QG catches errors
        : 'claude-opus-4-6'             // QG off: no safety net, get it right first time
      return {
        model,
        provider: inferProviderFromModel(model),
      }
    }
  }

  const { modelConfig } = resolveTeamModelConfig(workspaceConfig, presetOverride);
  const assignment = modelConfig.defaults[toCanonicalRole(role)];
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

// Implements REQ-P3: Auto thinking mode per strategy
// Thinking ON only for roles where judgment quality directly impacts output
const STRATEGY_THINKING: Record<string, Record<string, boolean>> = {
  smart:   { lead: true,  head: true,  worker: false, reviewer: true,  escalation: true  },
  codex:   { lead: false, head: false, worker: false, reviewer: true,  escalation: false },
  budget:  { lead: false, head: false, worker: false, reviewer: false, escalation: false },
}

/**
 * Resolve whether thinking (extended reasoning) should be enabled for a role.
 *
 * - Smart: Lead + Reviewer + Escalation get thinking (judgment quality matters)
 * - Codex: Only Reviewer gets thinking (Codex has built-in reasoning)
 * - Budget: All OFF (cost savings)
 * - Custom: Uses the explicit override
 */
export function resolveThinkingForRole(
  preset: string | undefined,
  role: TeamRole,
  customOverride?: boolean,
): boolean {
  if (!preset || preset === 'custom') {
    return customOverride ?? false
  }
  const strategyDefaults = STRATEGY_THINKING[preset]
  if (!strategyDefaults) return customOverride ?? false
  const canonicalRole = toCanonicalRole(role)
  return strategyDefaults[canonicalRole] ?? false
}
