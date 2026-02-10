/**
 * PromptBuilder - System Prompt and Context Building
 *
 * Provides utilities for building system prompts and context blocks that both
 * ClaudeAgent and CodexAgent can use. Handles workspace capabilities, recovery
 * context, and user preferences formatting.
 *
 * Key responsibilities:
 * - Build workspace capabilities context
 * - Format recovery context for session resume failures
 * - Build session state context blocks
 * - Format user preferences for prompt injection
 */

import { isLocalMcpEnabled, isAgentTeamsEnabled } from '../../workspaces/storage.ts';
import { formatPreferencesForPrompt } from '../../config/preferences.ts';
import { formatSessionState } from '../mode-manager.ts';
import { getDateTimeContext, getWorkingDirectoryContext } from '../../prompts/system.ts';
import { getSessionPlansPath, getSessionPath } from '../../sessions/storage.ts';
import type { Spec } from '@craft-agent/core/types';
import type {
  PromptBuilderConfig,
  ContextBlockOptions,
  RecoveryMessage,
} from './types.ts';

/**
 * PromptBuilder provides utilities for building prompts and context blocks.
 *
 * Usage:
 * ```typescript
 * const promptBuilder = new PromptBuilder({
 *   workspace,
 *   session,
 *   debugMode: { enabled: true },
 * });
 *
 * // Build context blocks for a user message
 * const contextParts = promptBuilder.buildContextParts({
 *   permissionMode: 'explore',
 *   plansFolderPath: '/path/to/plans',
 * });
 * ```
 */
export class PromptBuilder {
  private config: PromptBuilderConfig;
  private workspaceRootPath: string;
  private pinnedPreferencesPrompt: string | null = null;
  /** Active spec for SDD context (set at runtime via setSDDSpec) */
  private sddActiveSpec: Spec | null = null;

  constructor(config: PromptBuilderConfig) {
    this.config = config;
    this.workspaceRootPath = config.workspace?.rootPath ?? '';
  }

  // ============================================================
  // Context Building
  // ============================================================

  /**
   * Build all context parts for a user message.
   * Returns an array of strings that should be prepended to the user message.
   *
   * @param options - Context building options
   * @param sourceStateBlock - Pre-formatted source state (from SourceManager)
   * @returns Array of context strings
   */
  buildContextParts(
    options: ContextBlockOptions,
    sourceStateBlock?: string
  ): string[] {
    const parts: string[] = [];

    // Add date/time context first (enables prompt caching)
    parts.push(getDateTimeContext());

    // Add session state (permission mode, plans folder path)
    const sessionId = this.config.session?.id ?? `temp-${Date.now()}`;
    const plansFolderPath = options.plansFolderPath ??
      getSessionPlansPath(this.workspaceRootPath, sessionId);
    parts.push(formatSessionState(sessionId, { plansFolderPath }));

    // Add source state if provided
    if (sourceStateBlock) {
      parts.push(sourceStateBlock);
    }

    // Add workspace capabilities
    parts.push(this.formatWorkspaceCapabilities());

    // Add SDD context if enabled
    const sddContext = this.formatSDDContext();
    if (sddContext) {
      parts.push(sddContext);
    }

    // Add working directory context
    const workingDirContext = this.getWorkingDirectoryContext();
    if (workingDirContext) {
      parts.push(workingDirContext);
    }

    return parts;
  }

  /**
   * Format workspace capabilities for prompt injection.
   * Informs the agent about what features are available in this workspace.
   */
  formatWorkspaceCapabilities(): string {
    const capabilities: string[] = [];

    // Check local MCP server capability
    const localMcpEnabled = isLocalMcpEnabled(this.workspaceRootPath);
    if (localMcpEnabled) {
      capabilities.push('local-mcp: enabled (stdio subprocess servers supported)');
    } else {
      capabilities.push('local-mcp: disabled (only HTTP/SSE servers)');
    }

    // Agent teams capability
    const agentTeamsEnabled = isAgentTeamsEnabled(this.workspaceRootPath);
    if (agentTeamsEnabled) {
      capabilities.push('agent-teams: enabled (spawn teammates via Task tool with team_name)');
    } else {
      capabilities.push('agent-teams: disabled');
    }

    const capabilityBlock = `<workspace_capabilities>\n${capabilities.join('\n')}\n</workspace_capabilities>`;

    if (!agentTeamsEnabled) {
      return capabilityBlock;
    }

    const isCodex = this.config.agentBackend === 'codex';

    if (isCodex) {
      // Implements REQ-005: reinforce that workspace settings control teammate models
      // Codex agent teams use MCP tools from the session server.
      // These tools are intercepted via PreToolUse (toolType='mcp') and routed
      // to our agent teams system, which spawns real teammate sessions.
      return `${capabilityBlock}

<agent_teams>
enabled: true
You have MCP tools available from the "session" server for managing agent teams.

## Spawning Teammates
Use the **Task** MCP tool to spawn a teammate agent:
- team_name: string (required — team identifier, e.g. "my-team")
- name: string (required — teammate name, e.g. "researcher")
- prompt: string (required — task instructions for the teammate)
- model: string (optional — model override)

If agent teams are enabled and you create a plan/spec, you MUST either:
- Spawn appropriate teammates for work that benefits from parallel execution, OR
- Explicitly state in the chat that no team is needed and why.

Example: To spawn a researcher teammate, call the Task tool with:
  team_name: "project-team", name: "researcher", prompt: "Research the API docs and summarize the endpoints"

## Model Selection Note
Workspace settings control teammate models. Do not override the \`model\` field unless the user explicitly requests a different model.
Model overrides that conflict with workspace settings may be ignored.

## Sending Messages
Use the **SendMessage** MCP tool to communicate with teammates:
- type: "message" | "broadcast" | "shutdown_request"
- recipient: string (teammate name — required for "message" and "shutdown_request")
- content: string (message text)

## Creating Teams
Use the **TeamCreate** MCP tool to explicitly create a team (optional — teams are also created implicitly on first Task call):
- team_name: string (required)

Each teammate runs independently in its own session. Results are delivered automatically when they complete.
</agent_teams>`;
    }

    return `${capabilityBlock}

<agent_teams>
enabled: true
To spawn teammates, call the Task tool with:
- team_name: string (team id/name)
- name: string (teammate name)
- prompt: string (task to perform)
- model: string (optional)
Use SendMessage to message teammates (type: message | broadcast | shutdown_request).
If agent teams are enabled and you create a plan/spec, you MUST either spawn teammates or explicitly say no team is needed and why.
</agent_teams>`;
  }

  /**
   * Get working directory context for prompt injection.
   */
  getWorkingDirectoryContext(): string | null {
    const sessionId = this.config.session?.id;
    const effectiveWorkingDir = this.config.session?.workingDirectory ??
      (sessionId ? getSessionPath(this.workspaceRootPath, sessionId) : undefined);
    const isSessionRoot = !this.config.session?.workingDirectory && !!sessionId;

    return getWorkingDirectoryContext(
      effectiveWorkingDir,
      isSessionRoot,
      this.config.session?.sdkCwd
    );
  }

  // ============================================================
  // Spec-Driven Development (SDD) Context
  // ============================================================

  /**
   * Format SDD context for prompt injection.
   * Returns null if SDD is not enabled for this session.
   */
  private formatSDDContext(): string | null {
    if (!this.config.session?.sddEnabled) {
      return null;
    }

    const parts: string[] = [];
    parts.push(`<sdd_mode>`);
    parts.push(`This session is operating in **Spec-Driven Development (SDD)** mode.`);
    parts.push(``);
    parts.push(`## SDD Principles`);
    parts.push(``);
    parts.push(`All work in this session must be guided by structured specifications:`);
    parts.push(``);
    parts.push(`1. **Requirement Traceability** - Reference requirement IDs (e.g., \`REQ-001\`) in code comments, commit messages, and task descriptions. Every code change should trace back to a spec requirement.`);
    parts.push(`2. **DRI (Directly Responsible Individual)** - Each requirement and spec section should have a clear owner. When working in a team, assign DRI to teammates. In solo mode, you are the DRI.`);
    parts.push(`3. **Coverage Tracking** - Track which requirements are implemented, partially implemented, or not yet started. Aim for 100% requirement coverage before marking work complete.`);
    parts.push(`4. **Acceptance Tests** - Each requirement has acceptance tests. Verify these pass before marking a requirement as implemented.`);
    parts.push(`5. **Rollout Safety** - Consider rollback plans, monitoring, and feature flags for changes. Document these in the spec.`);
    parts.push(``);
    parts.push(`## SDD Workflow`);
    parts.push(``);
    parts.push(`- Before starting work, review the active spec and its requirements`);
    parts.push(`- When creating tasks (especially in agent teams), link them to requirement IDs via \`requirementIds\``);
    parts.push(`- Reference requirement IDs in code: \`// Implements REQ-001: User authentication\``);
    parts.push(`- When completing work, verify coverage against spec requirements`);
    parts.push(`- Generate a traceability report linking requirements → code → tests when asked`);

    if (this.sddActiveSpec) {
      const spec = this.sddActiveSpec;
      parts.push(``);
      parts.push(`## Active Spec: ${spec.title}`);
      parts.push(``);
      parts.push(`- **Status:** ${spec.status}`);
      parts.push(`- **Owner DRI:** ${spec.ownerDRI}`);
      if (spec.goals.length > 0) {
        parts.push(`- **Goals:** ${spec.goals.join('; ')}`);
      }
      if (spec.nonGoals.length > 0) {
        parts.push(`- **Non-Goals:** ${spec.nonGoals.join('; ')}`);
      }
      parts.push(``);
      parts.push(`### Requirements (${spec.requirements.length})`);
      parts.push(``);
      for (const req of spec.requirements) {
        const statusIcon = req.status === 'verified' ? '[x]' :
                          req.status === 'implemented' ? '[~]' :
                          req.status === 'in-progress' ? '[>]' : '[ ]';
        parts.push(`- ${statusIcon} **${req.id}** (${req.priority}): ${req.description}`);
        if (req.assignedDRI) {
          parts.push(`  - DRI: ${req.assignedDRI}`);
        }
      }

      if (spec.risks.length > 0) {
        parts.push(``);
        parts.push(`### Risks`);
        parts.push(``);
        for (const risk of spec.risks) {
          parts.push(`- **${risk.id}** (${risk.severity}): ${risk.description} → Mitigation: ${risk.mitigation}`);
        }
      }

      if (spec.rolloutPlan) {
        parts.push(``);
        parts.push(`### Rollout Plan`);
        parts.push(spec.rolloutPlan);
      }

      if (spec.rollbackPlan) {
        parts.push(``);
        parts.push(`### Rollback Plan`);
        parts.push(spec.rollbackPlan);
      }
    } else if (this.config.session?.activeSpecId) {
      parts.push(``);
      parts.push(`**Active Spec ID:** ${this.config.session.activeSpecId} (spec details not loaded — ask the user for the spec document or create one)`);
    } else {
      parts.push(``);
      parts.push(`**No active spec loaded.** Ask the user to provide or create a specification document to guide the work. A spec should include: title, goals, non-goals, requirements (with IDs and priorities), risks, and rollout/rollback plans.`);
    }

    parts.push(`</sdd_mode>`);
    return parts.join('\n');
  }

  /**
   * Set the active spec for SDD context injection.
   * Called at runtime when a spec is loaded or updated.
   */
  setSDDSpec(spec: Spec | null): void {
    this.sddActiveSpec = spec;
  }

  /**
   * Get the current active spec (if any).
   */
  getSDDSpec(): Spec | null {
    return this.sddActiveSpec;
  }

  // ============================================================
  // Recovery Context
  // ============================================================

  /**
   * Build recovery context from previous messages when SDK resume fails.
   * Called when we detect an empty response during resume.
   *
   * @param messages - Previous messages to include in recovery context
   * @returns Formatted recovery context string, or null if no messages
   */
  buildRecoveryContext(messages?: RecoveryMessage[]): string | null {
    if (!messages || messages.length === 0) {
      return null;
    }

    // Format messages as a conversation block
    const formattedMessages = messages.map((m) => {
      const role = m.type === 'user' ? 'User' : 'Assistant';
      // Truncate very long messages to avoid bloating context
      const content = m.content.length > 1000
        ? m.content.slice(0, 1000) + '...[truncated]'
        : m.content;
      return `[${role}]: ${content}`;
    }).join('\n\n');

    return `<conversation_recovery>
This session was interrupted and is being restored. Here is the recent conversation context:

${formattedMessages}

Please continue the conversation naturally from where we left off.
</conversation_recovery>

`;
  }

  // ============================================================
  // User Preferences
  // ============================================================

  /**
   * Format user preferences for prompt injection.
   * Preferences are pinned on first call to ensure consistency within a session.
   *
   * @param forceRefresh - Force refresh of cached preferences
   * @returns Formatted preferences string
   */
  formatPreferences(forceRefresh = false): string {
    // Return pinned preferences if available (ensures session consistency)
    if (this.pinnedPreferencesPrompt && !forceRefresh) {
      return this.pinnedPreferencesPrompt;
    }

    // Load and format preferences (function loads internally)
    this.pinnedPreferencesPrompt = formatPreferencesForPrompt();
    return this.pinnedPreferencesPrompt;
  }

  /**
   * Clear pinned preferences (called on session clear).
   */
  clearPinnedPreferences(): void {
    this.pinnedPreferencesPrompt = null;
  }

  // ============================================================
  // Configuration Accessors
  // ============================================================

  /**
   * Update the workspace configuration.
   */
  setWorkspace(workspace: PromptBuilderConfig['workspace']): void {
    this.config.workspace = workspace;
    this.workspaceRootPath = workspace?.rootPath ?? '';
  }

  /**
   * Update the session configuration.
   */
  setSession(session: PromptBuilderConfig['session']): void {
    this.config.session = session;
  }

  /**
   * Get the current session configuration.
   */
  getSession(): PromptBuilderConfig['session'] {
    return this.config.session;
  }

  /**
   * Get the workspace root path.
   */
  getWorkspaceRootPath(): string {
    return this.workspaceRootPath;
  }

  /**
   * Check if debug mode is enabled.
   */
  isDebugMode(): boolean {
    return this.config.debugMode?.enabled ?? false;
  }

  /**
   * Get the system prompt preset.
   */
  getSystemPromptPreset(): string {
    return this.config.systemPromptPreset ?? 'default';
  }
}
