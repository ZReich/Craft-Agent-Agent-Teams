/**
 * Session-Scoped Tools
 *
 * Tools that are scoped to a specific session. Each session gets its own
 * instance of these tools with session-specific callbacks and state.
 *
 * This file is a thin adapter that wraps the shared handlers from
 * @craft-agent/session-tools-core for use with the Claude SDK.
 *
 * Tools included:
 * - SubmitPlan: Submit a plan file for user review/display
 * - config_validate: Validate configuration files
 * - skill_validate: Validate skill SKILL.md files
 * - mermaid_validate: Validate Mermaid diagram syntax
 * - source_test: Validate schema, download icons, test connections
 * - source_oauth_trigger: Start OAuth authentication for MCP sources
 * - source_google_oauth_trigger: Start Google OAuth authentication
 * - source_slack_oauth_trigger: Start Slack OAuth authentication
 * - source_microsoft_oauth_trigger: Start Microsoft OAuth authentication
 * - source_credential_prompt: Prompt user for API credentials
 * - transform_data: Transform data files via script for datatable/spreadsheet blocks
 * - TeamKnowledgeQuery: Query shared team memory (REQ-NEXT-001)
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { getSessionPlansPath, getSessionDataPath, getSessionPath, loadSession } from '../sessions/storage.ts';
import { debug } from '../utils/debug.ts';
import { DOC_REFS } from '../docs/index.ts';
import { createClaudeContext } from './claude-context.ts';
import { basename, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { teamManager } from './agent-team-manager.ts';

// Import handlers from session-tools-core
import {
  handleSubmitPlan,
  handleConfigValidate,
  handleSkillValidate,
  handleMermaidValidate,
  handleSourceTest,
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
  handleCredentialPrompt,
  // Types
  type ToolResult,
  type AuthRequest,
} from '@craft-agent/session-tools-core';

// Re-export types for backward compatibility
export type {
  CredentialInputMode,
  AuthRequestType,
  AuthRequest,
  AuthResult,
  CredentialAuthRequest,
  McpOAuthAuthRequest,
  GoogleOAuthAuthRequest,
  SlackOAuthAuthRequest,
  MicrosoftOAuthAuthRequest,
  GoogleService,
  SlackService,
  MicrosoftService,
} from '@craft-agent/session-tools-core';

// ============================================================
// Session-Scoped Tool Callbacks
// ============================================================

/**
 * Callbacks that can be registered per-session
 */
export interface SessionScopedToolCallbacks {
  /**
   * Called when a plan is submitted via SubmitPlan tool.
   * Receives the path to the plan markdown file.
   */
  onPlanSubmitted?: (planPath: string) => void;

  /**
   * Called when authentication is requested via OAuth/credential tools.
   * The auth UI should be shown and execution paused.
   */
  onAuthRequest?: (request: AuthRequest) => void;
}

// Registry of callbacks keyed by sessionId
const sessionScopedToolCallbackRegistry = new Map<string, SessionScopedToolCallbacks>();

/**
 * Register callbacks for a specific session
 */
export function registerSessionScopedToolCallbacks(
  sessionId: string,
  callbacks: SessionScopedToolCallbacks
): void {
  sessionScopedToolCallbackRegistry.set(sessionId, callbacks);
  debug('session-scoped-tools', `Registered callbacks for session ${sessionId}`);
}

/**
 * Unregister callbacks for a session
 */
export function unregisterSessionScopedToolCallbacks(sessionId: string): void {
  sessionScopedToolCallbackRegistry.delete(sessionId);
  debug('session-scoped-tools', `Unregistered callbacks for session ${sessionId}`);
}

/**
 * Get callbacks for a session
 */
function getSessionScopedToolCallbacks(sessionId: string): SessionScopedToolCallbacks | undefined {
  return sessionScopedToolCallbackRegistry.get(sessionId);
}

// ============================================================
// Plan State Management
// ============================================================

// Map of sessionId -> last submitted plan path (for retrieval after submission)
const sessionPlanFilePaths = new Map<string, string>();

/**
 * Get the last submitted plan file path for a session
 */
export function getLastPlanFilePath(sessionId: string): string | null {
  return sessionPlanFilePaths.get(sessionId) ?? null;
}

/**
 * Set the last submitted plan file path for a session
 */
function setLastPlanFilePath(sessionId: string, path: string): void {
  sessionPlanFilePaths.set(sessionId, path);
}

/**
 * Clear plan file state for a session
 */
export function clearPlanFileState(sessionId: string): void {
  sessionPlanFilePaths.delete(sessionId);
}

// ============================================================
// Plan Path Helpers
// ============================================================

/**
 * Get the plans directory for a session
 */
export function getSessionPlansDir(workspacePath: string, sessionId: string): string {
  return getSessionPlansPath(workspacePath, sessionId);
}

/**
 * Check if a path is within a session's plans directory
 */
export function isPathInPlansDir(path: string, workspacePath: string, sessionId: string): boolean {
  const plansDir = getSessionPlansDir(workspacePath, sessionId);
  return path.startsWith(plansDir);
}

// ============================================================
// Tool Result Converter
// ============================================================

/**
 * Convert shared ToolResult to SDK format
 */
function convertResult(result: ToolResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return {
    content: result.content.map(c => ({ type: 'text' as const, text: c.text })),
    ...(result.isError ? { isError: true } : {}),
  };
}

// ============================================================
// Cache for Session-Scoped Tools
// ============================================================

// Cache tools by session to avoid recreating them
const sessionScopedToolsCache = new Map<string, ReturnType<typeof createSdkMcpServer>>();

/**
 * Clean up cached tools for a session
 */
export function cleanupSessionScopedTools(sessionId: string): void {
  sessionScopedToolsCache.delete(sessionId);
}

// ============================================================
// Tool Schemas
// ============================================================
// Note: _displayName/_intent metadata is injected dynamically by the network
// interceptor and stripped by pre-tool-use.ts before Zod validation runs.
// Do NOT add them here — stripping happens first, causing validation failures.

const submitPlanSchema = {
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
};

const configValidateSchema = {
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'hooks', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
};

const skillValidateSchema = {
  skillSlug: z.string().describe('The slug of the skill to validate'),
};

const mermaidValidateSchema = {
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
};

const sourceTestSchema = {
  sourceSlug: z.string().describe('The slug of the source to test'),
};

const sourceOAuthTriggerSchema = {
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
};

const credentialPromptSchema = {
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
};

const transformDataSchema = {
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
};

const teamKnowledgeQuerySchema = {
  tags: z.array(z.string()).optional().describe('Semantic tags to query (e.g., ["auth", "api", "jwt"]). If omitted, returns the most recent team knowledge entries.'),
  filePath: z.string().optional().describe('Optional file path filter for file-specific knowledge and conflict warnings'),
  query: z.string().optional().describe('Optional free-text query. Keywords are converted to tags when tags are not provided.'),
  limit: z.number().int().min(1).max(25).optional().describe('Max number of knowledge entries to return (default: 10)'),
  includeConflicts: z.boolean().optional().describe('Include conflict registry warnings (requires filePath for precise filtering)'),
};

// ============================================================
// Tool Descriptions
// ============================================================

const TOOL_DESCRIPTIONS = {
  SubmitPlan: `Submit a plan for user review.

Call this after you have written your plan to a markdown file using the Write tool.
The plan will be displayed to the user in a special formatted view.

**IMPORTANT:** After calling this tool:
- Execution will be **automatically paused** to present the plan to the user
- No further tool calls or text output will be processed after this tool returns
- The conversation will resume when the user responds (accept, modify, or reject the plan)
- Do NOT include any text or tool calls after SubmitPlan - they will not be executed`,

  config_validate: `Validate Craft Agent configuration files.

Use this after editing configuration files to check for errors before they take effect.
Returns structured validation results with errors, warnings, and suggestions.

**Targets:**
- \`config\`: Validates ~/.craft-agent/config.json (workspaces, model, settings)
- \`sources\`: Validates all sources in ~/.craft-agent/workspaces/{workspace}/sources/*/config.json
- \`statuses\`: Validates ~/.craft-agent/workspaces/{workspace}/statuses/config.json
- \`preferences\`: Validates ~/.craft-agent/preferences.json
- \`permissions\`: Validates permissions.json files
- \`tool-icons\`: Validates ~/.craft-agent/tool-icons/tool-icons.json
- \`all\`: Validates all configuration files

**Reference:** ${DOC_REFS.sources}`,

  skill_validate: `Validate a skill's SKILL.md file.

Checks:
- Slug format (lowercase alphanumeric with hyphens)
- SKILL.md exists and is readable
- YAML frontmatter is valid with required fields (name, description)
- Content is non-empty after frontmatter
- Icon format if present (svg/png/jpg)

**Reference:** ${DOC_REFS.skills}`,

  mermaid_validate: `Validate Mermaid diagram syntax before outputting.

Use this when:
- Creating complex diagrams with many nodes/relationships
- Unsure about syntax for a specific diagram type
- Debugging a diagram that failed to render

Returns validation result with specific error messages if invalid.

**Reference:** ${DOC_REFS.mermaid}`,

  source_test: `Validate and test a source configuration.

**This tool performs:**
1. **Schema validation**: Validates config.json structure
2. **Icon handling**: Checks/downloads icon if configured
3. **Completeness check**: Warns about missing guide.md/icon/tagline
4. **Connection test**: Tests if the source is reachable
5. **Auth status**: Checks if source is authenticated

**Reference:** ${DOC_REFS.sources}`,

  source_oauth_trigger: `Start OAuth authentication for an MCP source.

This tool initiates the OAuth 2.0 + PKCE flow for sources that require authentication.

**Prerequisites:**
- Source must exist in the current workspace
- Source must be type 'mcp' with authType 'oauth'
- Source must have a valid MCP URL

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_google_oauth_trigger: `Trigger Google OAuth authentication for a Google API source.

Opens a browser window for the user to sign in with their Google account.

**Supported services:** Gmail, Calendar, Drive

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_slack_oauth_trigger: `Trigger Slack OAuth authentication for a Slack API source.

Opens a browser window for the user to sign in with their Slack account.

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth authentication for a Microsoft API source.

Opens a browser window for the user to sign in with their Microsoft account.

**Supported services:** Outlook, Calendar, OneDrive, Teams, SharePoint

**IMPORTANT:** After calling this tool, execution will be paused while OAuth completes.`,

  transform_data: `Transform data files using a script and write structured output for datatable/spreadsheet blocks.

Use this tool when you need to transform large datasets (20+ rows) into structured JSON for display. Instead of outputting all rows inline, write a transform script that reads the input file and produces a JSON output file, then reference it via \`"src"\` in your datatable/spreadsheet block.

**Workflow:**
1. Call \`transform_data\` with a script that reads input files and writes JSON output
2. Output a datatable/spreadsheet block with \`"src": "data/output.json"\` referencing the output file

**Script conventions:**
- Input file paths are passed as command-line arguments (last arg = output file path)
- Python: \`sys.argv[1:-1]\` = input files, \`sys.argv[-1]\` = output path
- Node/Bun: \`process.argv.slice(2, -1)\` = input files, \`process.argv.at(-1)\` = output path
- Output must be valid JSON: \`{"title": "...", "columns": [...], "rows": [...]}\`

**Security:** Runs in an isolated subprocess with no access to API keys or credentials. 30-second timeout.`,

  TeamKnowledgeQuery: `Query shared team memory from the Team Knowledge Bus (REQ-NEXT-001).

Use this tool when you want explicit memory retrieval instead of rediscovering context from scratch.
It returns cross-teammate discoveries, patterns, decisions, interface-contract notes, and conflict warnings.

Best use cases:
- "What do we already know about auth/session handling?"
- "Show prior discoveries for src/api/routes.ts"
- "Did anyone report conflicts on this file?"

If tags are omitted, the tool returns the most recent knowledge entries for the active team session.`,

  source_credential_prompt: `Prompt the user to enter credentials for a source.

Use this when a source requires authentication that isn't OAuth.
The user will see a secure input UI with appropriate fields based on the auth mode.

**Auth Modes:**
- \`bearer\`: Single token field (Bearer Token, API Key)
- \`basic\`: Username and Password fields
- \`header\`: API Key with custom header name shown
- \`query\`: API Key for query parameter auth

**IMPORTANT:** After calling this tool, execution will be paused for user input.`,
};

// ============================================================
// Env Vars to Strip from Subprocess
// ============================================================

const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'NPM_TOKEN',
];

// ============================================================
// transform_data Handler
// ============================================================

const TRANSFORM_DATA_TIMEOUT_MS = 30_000;

async function handleTransformData(
  sessionId: string,
  workspaceRootPath: string,
  args: {
    language: 'python3' | 'node' | 'bun';
    script: string;
    inputFiles: string[];
    outputFile: string;
  }
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sessionDir = getSessionPath(workspaceRootPath, sessionId);
  const dataDir = getSessionDataPath(workspaceRootPath, sessionId);

  // Validate outputFile doesn't escape data/ directory
  const resolvedOutput = resolve(dataDir, args.outputFile);
  if (!resolvedOutput.startsWith(normalize(dataDir))) {
    return {
      content: [{ type: 'text', text: `Error: outputFile must be within the session data directory. Got: ${args.outputFile}` }],
      isError: true,
    };
  }

  // Resolve and validate input files (relative to session dir)
  const resolvedInputs: string[] = [];
  for (const inputFile of args.inputFiles) {
    const resolvedInput = resolve(sessionDir, inputFile);
    if (!resolvedInput.startsWith(normalize(sessionDir))) {
      return {
        content: [{ type: 'text', text: `Error: inputFile must be within the session directory. Got: ${inputFile}` }],
        isError: true,
      };
    }
    if (!existsSync(resolvedInput)) {
      return {
        content: [{ type: 'text', text: `Error: input file not found: ${inputFile}` }],
        isError: true,
      };
    }
    resolvedInputs.push(resolvedInput);
  }

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Write script to temp file
  const ext = args.language === 'python3' ? '.py' : '.js';
  const tempScript = join(tmpdir(), `craft-transform-${sessionId}-${Date.now()}${ext}`);
  writeFileSync(tempScript, args.script, 'utf-8');

  try {
    // Build command
    const cmd = args.language === 'python3' ? 'python3' : args.language;
    const spawnArgs = [tempScript, ...resolvedInputs, resolvedOutput];

    // Strip sensitive env vars
    const env = { ...process.env };
    for (const key of BLOCKED_ENV_VARS) {
      delete env[key];
    }

    // Spawn subprocess
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolvePromise, reject) => {
      const child = spawn(cmd, spawnArgs, {
        cwd: dataDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: TRANSFORM_DATA_TIMEOUT_MS,
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      child.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      child.on('close', (code) => {
        resolvePromise({ stdout, stderr, code });
      });

      child.on('error', (err) => {
        reject(err);
      });
    });

    if (result.code !== 0) {
      const errorOutput = result.stderr || result.stdout || 'Script exited with non-zero code';
      return {
        content: [{ type: 'text', text: `Script failed (exit code ${result.code}):\n${errorOutput.slice(0, 2000)}` }],
        isError: true,
      };
    }

    // Verify output file was created
    if (!existsSync(resolvedOutput)) {
      return {
        content: [{ type: 'text', text: `Script completed but output file was not created: ${args.outputFile}\n\nStdout: ${result.stdout.slice(0, 500)}` }],
        isError: true,
      };
    }

    // Return the absolute path for use in the datatable/spreadsheet "src" field
    // The UI's file reader requires absolute paths for security validation
    const lines = [`Output written to: ${resolvedOutput}`];
    lines.push(`\nUse this absolute path as the "src" value in your datatable or spreadsheet block.`);
    if (result.stdout.trim()) {
      lines.push(`\nStdout:\n${result.stdout.slice(0, 500)}`);
    }

    debug('session-scoped-tools', `transform_data succeeded: ${resolvedOutput}`);
    return {
      content: [{ type: 'text', text: lines.join('') }],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error running script: ${msg}` }],
      isError: true,
    };
  } finally {
    // Clean up temp script
    try { unlinkSync(tempScript); } catch { /* ignore */ }
  }
}

// ============================================================
// TeamKnowledgeQuery Handler (REQ-NEXT-001)
// ============================================================

function keywordTagsFromQuery(query?: string): string[] {
  if (!query) return [];
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_-]+/g)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3)
        .slice(0, 20),
    ),
  );
}

function resolveTeamIdForSession(workspaceRootPath: string, sessionId: string): string | null {
  const session = loadSession(workspaceRootPath, sessionId);
  if (!session) return null;

  if (session.teamId) {
    return teamManager.resolveTeamId(session.teamId);
  }

  if (session.parentSessionId) {
    const parent = loadSession(workspaceRootPath, session.parentSessionId);
    if (parent?.teamId) {
      return teamManager.resolveTeamId(parent.teamId);
    }
  }

  return null;
}

async function handleTeamKnowledgeQuery(
  sessionId: string,
  workspaceRootPath: string,
  args: {
    tags?: string[];
    filePath?: string;
    query?: string;
    limit?: number;
    includeConflicts?: boolean;
  },
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const teamId = resolveTeamIdForSession(workspaceRootPath, sessionId);
  if (!teamId) {
    return {
      content: [{
        type: 'text',
        text: 'No active team context found for this session. Team knowledge is available only inside agent-team sessions.',
      }],
      isError: true,
    };
  }

  const limit = Math.max(1, Math.min(25, Number(args.limit ?? 10)));
  const tags = (args.tags && args.tags.length > 0)
    ? args.tags
    : keywordTagsFromQuery(args.query);

  const rows: Array<{
    id: string;
    type: string;
    source: string;
    content: string;
    tags: string[];
    filePaths: string[];
    timestamp: number;
  }> = [];
  const seen = new Set<string>();

  const addRows = (entries: Array<{
    id: string;
    type: string;
    source: string;
    content: string;
    tags: string[];
    filePaths?: string[];
    timestamp: number;
  }>) => {
    for (const entry of entries) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      rows.push({
        id: entry.id,
        type: entry.type,
        source: entry.source,
        content: entry.content,
        tags: entry.tags ?? [],
        filePaths: entry.filePaths ?? [],
        timestamp: entry.timestamp,
      });
    }
  };

  if (args.filePath) {
    addRows(teamManager.queryKnowledgeByFile(teamId, args.filePath));
  }
  if (args.query && args.query.trim().length > 0) {
    addRows(teamManager.queryKnowledgeText(teamId, args.query, limit));
  }
  addRows(teamManager.queryKnowledge(teamId, tags, limit));

  const ordered = rows
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  const actorSession = loadSession(workspaceRootPath, sessionId);
  const actorName = actorSession?.teammateName || actorSession?.name || sessionId;
  teamManager.logActivity(
    teamId,
    'phase-advanced',
    `[KnowledgeBus][query] results=${ordered.length} limit=${limit}${args.filePath ? ` file=${args.filePath}` : ''}${args.query ? ' text=true' : ''}`,
    sessionId,
    actorName,
  );

  const lines: string[] = [];
  lines.push(`Team Knowledge results (${ordered.length}) for team "${teamId}":`);

  if (ordered.length === 0) {
    lines.push('- No matching shared knowledge entries found.');
    lines.push('- Tip: try broader tags or omit filters to fetch recent memory.');
  } else {
    for (const entry of ordered) {
      const whenIso = new Date(entry.timestamp).toISOString();
      const fileHint = entry.filePaths.length > 0 ? ` | files: ${entry.filePaths.slice(0, 3).join(', ')}` : '';
      const tagHint = entry.tags.length > 0 ? ` | tags: ${entry.tags.slice(0, 6).join(', ')}` : '';
      lines.push(`- [${entry.type}] ${entry.source} @ ${whenIso}${fileHint}${tagHint}`);
      lines.push(`  ${entry.content}`);
    }
  }

  if (args.includeConflicts) {
    const filePath = args.filePath;
    if (filePath) {
      const conflicts = teamManager.getKnowledgeConflicts(teamId, filePath).slice(0, 5);
      if (conflicts.length > 0) {
        lines.push('', `Conflict warnings for ${filePath}:`);
        for (const conflict of conflicts) {
          const editors = conflict.editors.map((editor) => editor.teammateName).join(', ');
          lines.push(`- ${new Date(conflict.detectedAt).toISOString()} | editors: ${editors}`);
        }
      } else {
        lines.push('', `Conflict warnings for ${filePath}: none`);
      }
    } else {
      lines.push('', 'Conflict warnings requested: provide filePath for precise conflict lookup.');
    }
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
  };
}

// ============================================================
// Main Factory Function
// ============================================================

/**
 * Get or create session-scoped tools for a session.
 * Returns an MCP server with all session-scoped tools registered.
 */
export function getSessionScopedTools(
  sessionId: string,
  workspaceRootPath: string,
  workspaceId?: string
): ReturnType<typeof createSdkMcpServer> {
  const cacheKey = `${sessionId}::${workspaceRootPath}`;

  // Return cached if available
  let cached = sessionScopedToolsCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  // Create Claude context with full capabilities
  const ctx = createClaudeContext({
    sessionId,
    workspacePath: workspaceRootPath,
    workspaceId: workspaceId || basename(workspaceRootPath) || '',
    onPlanSubmitted: (planPath: string) => {
      setLastPlanFilePath(sessionId, planPath);
      const callbacks = getSessionScopedToolCallbacks(sessionId);
      callbacks?.onPlanSubmitted?.(planPath);
    },
    onAuthRequest: (request: unknown) => {
      const callbacks = getSessionScopedToolCallbacks(sessionId);
      callbacks?.onAuthRequest?.(request as AuthRequest);
    },
  });

  // Create tools using shared handlers
  const tools = [
    // SubmitPlan
    tool('SubmitPlan', TOOL_DESCRIPTIONS.SubmitPlan, submitPlanSchema, async (args) => {
      const result = await handleSubmitPlan(ctx, args);
      return convertResult(result);
    }),

    // config_validate
    tool('config_validate', TOOL_DESCRIPTIONS.config_validate, configValidateSchema, async (args) => {
      const result = await handleConfigValidate(ctx, args as { target: 'config' | 'sources' | 'statuses' | 'preferences' | 'permissions' | 'hooks' | 'tool-icons' | 'all'; sourceSlug?: string });
      return convertResult(result);
    }),

    // skill_validate
    tool('skill_validate', TOOL_DESCRIPTIONS.skill_validate, skillValidateSchema, async (args) => {
      const result = await handleSkillValidate(ctx, args);
      return convertResult(result);
    }),

    // mermaid_validate
    tool('mermaid_validate', TOOL_DESCRIPTIONS.mermaid_validate, mermaidValidateSchema, async (args) => {
      const result = await handleMermaidValidate(ctx, args);
      return convertResult(result);
    }),

    // source_test
    tool('source_test', TOOL_DESCRIPTIONS.source_test, sourceTestSchema, async (args) => {
      const result = await handleSourceTest(ctx, args);
      return convertResult(result);
    }),

    // source_oauth_trigger
    tool('source_oauth_trigger', TOOL_DESCRIPTIONS.source_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleSourceOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_google_oauth_trigger
    tool('source_google_oauth_trigger', TOOL_DESCRIPTIONS.source_google_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleGoogleOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_slack_oauth_trigger
    tool('source_slack_oauth_trigger', TOOL_DESCRIPTIONS.source_slack_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleSlackOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_microsoft_oauth_trigger
    tool('source_microsoft_oauth_trigger', TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, sourceOAuthTriggerSchema, async (args) => {
      const result = await handleMicrosoftOAuthTrigger(ctx, args);
      return convertResult(result);
    }),

    // source_credential_prompt
    tool('source_credential_prompt', TOOL_DESCRIPTIONS.source_credential_prompt, credentialPromptSchema, async (args) => {
      const result = await handleCredentialPrompt(ctx, args as {
        sourceSlug: string;
        mode: 'bearer' | 'basic' | 'header' | 'query';
        labels?: { credential?: string; username?: string; password?: string };
        description?: string;
        hint?: string;
        passwordRequired?: boolean;
      });
      return convertResult(result);
    }),

    // transform_data
    tool('transform_data', TOOL_DESCRIPTIONS.transform_data, transformDataSchema, async (args) => {
      return handleTransformData(sessionId, workspaceRootPath, args);
    }),

    // TeamKnowledgeQuery (REQ-NEXT-001)
    tool('TeamKnowledgeQuery', TOOL_DESCRIPTIONS.TeamKnowledgeQuery, teamKnowledgeQuerySchema, async (args) => {
      return handleTeamKnowledgeQuery(sessionId, workspaceRootPath, args);
    }),

  ];

  // Create MCP server
  cached = createSdkMcpServer({
    name: 'session',
    version: '1.0.0',
    tools,
  });

  sessionScopedToolsCache.set(cacheKey, cached);
  return cached;
}
