/**
 * Workspace Types
 *
 * Workspaces are the top-level organizational unit. Everything (sources, sessions)
 * is scoped to a workspace.
 *
 * Directory structure:
 * ~/.craft-agent/workspaces/{slug}/
 *   ├── config.json      - Workspace settings
 *   ├── sources/         - Data sources (MCP, API, local)
 *   └── sessions/        - Conversation sessions
 */

import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import type { QualityGateConfig } from '@craft-agent/core/types';

/**
 * Local MCP server configuration
 * Controls whether stdio-based (local subprocess) MCP servers can be spawned.
 */
export interface LocalMcpConfig {
  /**
   * Whether local (stdio) MCP servers are enabled for this workspace.
   * When false, only HTTP-based MCP servers will be used.
   * Default: true (can be overridden by CRAFT_LOCAL_MCP_ENABLED env var)
   */
  enabled: boolean;
}

/**
 * Agent Teams configuration
 * Controls the experimental agent teams feature (multi-agent orchestration)
 */
export interface AgentTeamsConfig {
  /** Whether agent teams are enabled for this workspace (default: false) */
  enabled: boolean;
  /** Default model configuration for team roles */
  modelDefaults?: TeamModelDefaults;
  /** Selected model preset ID (e.g., 'max-quality', 'balanced', 'cost-optimized', 'budget', 'custom') */
  modelPreset?: string;
  /** Model ID for the lead role */
  leadModel?: string;
  /** Model ID for the head role */
  headModel?: string;
  /** Model ID for worker agents */
  workerModel?: string;
  /** Model ID for the reviewer role (quality gate AI reviews) */
  reviewerModel?: string;
  /** Model ID for escalation handling */
  escalationModel?: string;
  /** Cost cap per session in USD (optional) */
  costCapUsd?: number;
  /** Auto-escalation: upgrade worker model after N failures */
  autoEscalationThreshold?: number;
  /** Quality gate configuration — automated code review pipeline */
  qualityGates?: Partial<QualityGateConfig>;
}

/**
 * Default model assignments for team roles
 */
export interface TeamModelDefaults {
  lead?: { model: string; provider: string };
  head?: { model: string; provider: string };
  worker?: { model: string; provider: string };
  reviewer?: { model: string; provider: string };
  escalation?: { model: string; provider: string };
}

/**
 * Workspace configuration (stored in config.json)
 */
export interface WorkspaceConfig {
  id: string;
  name: string;
  slug: string; // Folder name (URL-safe)

  /**
   * Default settings for new sessions in this workspace
   */
  defaults?: {
    model?: string;
    /** Default LLM connection for new sessions (slug). Overrides global default. */
    defaultLlmConnection?: string;
    enabledSourceSlugs?: string[]; // Sources to enable by default
    permissionMode?: PermissionMode; // Default permission mode ('safe', 'ask', 'allow-all')
    cyclablePermissionModes?: PermissionMode[]; // Which modes can be cycled with SHIFT+TAB (min 2, default: all 3)
    workingDirectory?: string;
    thinkingLevel?: ThinkingLevel; // Default thinking level ('off', 'think', 'max') - default: 'think'
    colorTheme?: string; // Color theme override for this workspace (preset ID). Undefined = inherit from app default.
  };

  /**
   * Agent Teams configuration.
   * When enabled, the SDK exposes team-related tools (spawn teammate, message, broadcast, task management).
   * Off by default — when disabled, Craft Agents behaves identically to stock.
   */
  agentTeams?: AgentTeamsConfig;

  /**
   * Local MCP server configuration.
   * Controls whether stdio-based MCP servers can be spawned in this workspace.
   * Resolution order: ENV (CRAFT_LOCAL_MCP_ENABLED) > workspace config > default (true)
   */
  localMcpServers?: LocalMcpConfig;

  createdAt: number;
  updatedAt: number;
}

/**
 * Workspace creation input
 */
export interface CreateWorkspaceInput {
  name: string;
  defaults?: WorkspaceConfig['defaults'];
}

/**
 * Loaded workspace with resolved sources
 */
export interface LoadedWorkspace {
  config: WorkspaceConfig;
  sourceSlugs: string[]; // Available source slugs (not fully loaded to save memory)
  sessionCount: number; // Number of sessions
}

/**
 * Workspace summary for listing (lightweight)
 */
export interface WorkspaceSummary {
  slug: string;
  name: string;
  sourceCount: number;
  sessionCount: number;
  createdAt: number;
  updatedAt: number;
}
