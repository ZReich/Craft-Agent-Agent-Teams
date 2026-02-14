import { app } from 'electron'
import * as Sentry from '@sentry/electron/main'
import { basename, join } from 'path'
import { homedir } from 'os'
import { existsSync, watch } from 'fs'
import { rm, readFile, mkdir, writeFile, rename, open } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { CraftAgent, type AgentEvent, setPermissionMode, type PermissionMode, unregisterSessionScopedToolCallbacks, AbortReason, type AuthRequest, type AuthResult, type CredentialAuthRequest } from '@craft-agent/shared/agent'
import {
  CodexBackend,
  CodexAgent,
  CopilotAgent,
  detectProvider,
  resolveSessionConnection,
  providerTypeToAgentProvider,
  connectionAuthTypeToBackendAuthType,
  createBackendFromConnection,
  type LlmAuthType,
} from '@craft-agent/shared/agent/backend'
import {
  generateCodexConfig,
  generateBridgeConfig,
  getCredentialCachePath,
  type CredentialCacheEntry,
} from '@craft-agent/shared/codex'
import { getLlmConnection, getDefaultLlmConnection } from '@craft-agent/shared/config'
import type { LlmConnection } from '@craft-agent/shared/config/llm-connections'
import { sessionLog, isDebugMode, getLogFilePath } from './logger'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { WindowManager } from './window-manager'
import {
  loadStoredConfig,
  getWorkspaces,
  getWorkspaceByNameOrId,
  loadConfigDefaults,

  migrateLegacyCredentials,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  type Workspace,
} from '@craft-agent/shared/config'
import { loadWorkspaceConfig, isAgentTeamsEnabled } from '@craft-agent/shared/workspaces'
import { getLlmConnections } from '@craft-agent/shared/config'
import {
  // Session persistence functions
  listSessions as listStoredSessions,
  loadSession as loadStoredSession,
  saveSession as saveStoredSession,
  createSession as createStoredSession,
  deleteSession as deleteStoredSession,
  updateSessionMetadata,
  canUpdateSdkCwd,
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
  getSessionAttachmentsPath,
  getSessionPath as getSessionStoragePath,
  sessionPersistenceQueue,
  // Sub-session functions
  createSubSession as createStoredSubSession,
  getSessionFamily as getStoredSessionFamily,
  updateSiblingOrder as updateStoredSiblingOrder,
  archiveSessionCascade as archiveStoredSessionCascade,
  deleteSessionCascade as deleteStoredSessionCascade,
  getChildSessions as getStoredChildSessions,
  type StoredSession,
  type StoredMessage,
  type SessionMetadata,
  type TodoState,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { loadWorkspaceSources, loadAllSources, getSourcesBySlugs, isSourceUsable, type LoadedSource, type McpServerConfig, getSourcesNeedingAuth, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter } from '@craft-agent/shared/sources'
import { ConfigWatcher, type ConfigWatcherCallbacks } from '@craft-agent/shared/config'
import { getValidClaudeOAuthToken } from '@craft-agent/shared/auth'
import { setAnthropicOptionsEnv, setPathToClaudeCodeExecutable, setInterceptorPath, setExecutable, setAgentTeamsEnabled as setAgentTeamsEnvFlag } from '@craft-agent/shared/agent'
import { toolMetadataStore } from '@craft-agent/shared/network-interceptor'
import { getCredentialManager } from '@craft-agent/shared/credentials'
import { CraftMcpClient } from '@craft-agent/shared/mcp'
import { type Session, type Message, type SessionEvent, type FileAttachment, type StoredAttachment, type SendMessageOptions, type SessionProcessReapOptions, type SessionProcessReapReport, type SessionProcessCandidate, IPC_CHANNELS, generateMessageId } from '../shared/types'
import { formatPathsToRelative, formatToolInputPaths, perf, encodeIconToDataUrl, getEmojiIcon, resetSummarizationClient, resolveToolIcon } from '@craft-agent/shared/utils'
import { loadWorkspaceSkills, type LoadedSkill } from '@craft-agent/shared/skills'
import type { ToolDisplayMeta, QualityGateConfig, QualityGateResult, SpecComplianceReport, SessionUsage, ProviderUsage, TeamSessionUsage, AgentEventUsage, TeamRole, Spec, SpecRequirement, SpecRisk, SpecTemplate, DRIAssignment } from '@craft-agent/core/types'
import { QualityGateRunner, formatFailureReport, formatSuccessReport, type TaskContext } from './quality-gate-runner'
import { mergeQualityGateConfig } from '@craft-agent/shared/agent-teams/quality-gates'
import { DiffCollector, type ReviewDiff } from '@craft-agent/shared/agent-teams/diff-collector'
import { TeammateHealthMonitor, type HealthIssue } from '@craft-agent/shared/agent-teams/health-monitor'
import { exportCompactSpec } from '@craft-agent/shared/agent-teams/sdd-exports'
import { resolveTeamModelForRole } from '@craft-agent/shared/agent-teams/model-resolution'
import { YoloOrchestrator, mergeYoloConfig, type YoloCallbacks } from '@craft-agent/shared/agent-teams/yolo-orchestrator'
import type { YoloConfig, YoloState } from '@craft-agent/core/types'
import { getToolIconsDir, isCodexModel, getMiniModel, DEFAULT_MODEL, DEFAULT_CODEX_MODEL, getSummarizationModel } from '@craft-agent/shared/config'
import type { SummarizeCallback } from '@craft-agent/shared/sources'
import { type ThinkingLevel, DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'
import { evaluateAutoLabels } from '@craft-agent/shared/labels/auto'
import { listLabels } from '@craft-agent/shared/labels/storage'
import { extractLabelId } from '@craft-agent/shared/labels'
import { teamManager } from '@craft-agent/shared/agent/agent-team-manager'
import { calculateTokenCostUsd, inferProviderFromModel, type UsageProvider } from '@craft-agent/shared/usage'
import { buildTeammateCodename, buildTeamCodename, teammateMatchesTargetName } from './teammate-codenames'
import { UsagePersistence, UsageAlertChecker } from '@craft-agent/shared/usage'
import type { SessionUsage as PersistedSessionUsage, UsageAlert, UsageAlertThresholds } from '@craft-agent/core'
import type { FSWatcher } from 'fs'
import { HookSystem, type HookSystemMetadataSnapshot } from '@craft-agent/shared/hooks-simple'

// Import and re-export (extracted to avoid Electron dependency in tests)
import { sanitizeForTitle } from './title-sanitizer'
export { sanitizeForTitle }

/**
 * Resolve the usage provider from a connection's providerType and model.
 * Replaces repeated nested ternary: openai → 'openai', openai_compat → infer from model, else → 'anthropic'.
 */
function resolveUsageProvider(providerType: string | undefined, model: string | undefined): UsageProvider {
  switch (providerType) {
    case 'openai': return 'openai'
    case 'openai_compat': return inferProviderFromModel(model)
    default: return 'anthropic'
  }
}

/**
 * Get the path to the bundled Bun executable.
 * - Packaged app: returns path to bundled Bun in vendor/bun
 * - Development: returns undefined (caller should use system 'bun' command)
 *
 * Used for:
 * - Claude SDK subprocess execution (setExecutable)
 * - Codex session MCP server (nodePath in config.toml)
 */
function getBundledBunPath(): string | undefined {
  const basePath = app.getAppPath()
  const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun'
  // On Windows, bun.exe is in extraResources (process.resourcesPath) to avoid EBUSY errors.
  // On macOS/Linux, bun is in the app files (basePath). See electron-builder.yml for details.
  const bunBasePath = process.platform === 'win32' ? process.resourcesPath : basePath
  const bunPath = join(bunBasePath, 'vendor', 'bun', bunBinary)

  if (existsSync(bunPath)) {
    return bunPath
  }

  // In dev mode on Windows, the .cmd wrapper from npm can't be spawned directly by
  // child_process.spawn() (ENOENT). Find the actual bun.exe binary instead.
  if (!app.isPackaged && process.platform === 'win32') {
    const { execSync } = require('child_process')
    try {
      const result = execSync('where bun.exe', { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n')[0]
      if (result && existsSync(result.trim())) {
        sessionLog.info(`Using system bun.exe for dev mode: ${result.trim()}`)
        return result.trim()
      }
    } catch { /* bun.exe not on PATH */ }
    // Try known npm global location
    const npmBunExe = join(process.env.APPDATA || '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe')
    if (existsSync(npmBunExe)) {
      sessionLog.info(`Using npm-installed bun.exe for dev mode: ${npmBunExe}`)
      return npmBunExe
    }
  }

  sessionLog.warn(`Bundled Bun not found at ${bunPath}`)
  return undefined
}

function normalizeModelList(models?: Array<{ id: string } | string>): string[] {
  if (!models) return []
  return models
    .map(model => (typeof model === 'string' ? model : model.id))
    .filter(Boolean)
}

function connectionSupportsModel(connection: LlmConnection, model: string): boolean {
  if (connection.defaultModel === model) return true
  const normalizedModels = normalizeModelList(connection.models)
  return normalizedModels.includes(model)
}

function isMoonshotConnection(connection: LlmConnection): boolean {
  const name = connection.name?.toLowerCase?.() ?? ''
  const baseUrl = connection.baseUrl?.toLowerCase?.() ?? ''
  return name.includes('moonshot') || name.includes('kimi') || baseUrl.includes('moonshot')
}

function resolveConnectionForModel(options: {
  model: string
  parentConnectionSlug?: string
  workspaceDefaultSlug?: string
}): string | undefined {
  const { model, parentConnectionSlug, workspaceDefaultSlug } = options
  const connections = getLlmConnections()

  const parent = parentConnectionSlug ? getLlmConnection(parentConnectionSlug) : null
  if (parent && connectionSupportsModel(parent, model)) return parent.slug

  const workspaceDefault = workspaceDefaultSlug ? getLlmConnection(workspaceDefaultSlug) : null
  if (workspaceDefault && connectionSupportsModel(workspaceDefault, model)) return workspaceDefault.slug

  const provider = inferProviderFromModel(model)
  const providerOrder: Array<LlmConnection['providerType']> = provider === 'openai'
    ? ['openai']
    : provider === 'anthropic'
      ? ['anthropic', 'anthropic_compat', 'bedrock', 'vertex']
      : ['openai_compat', 'anthropic_compat']

  const supported = connections.filter(conn => connectionSupportsModel(conn, model))
  for (const providerType of providerOrder) {
    const match = supported.find(conn => conn.providerType === providerType)
    if (match) return match.slug
  }

  if (provider === 'moonshot') {
    const moonshotConn = connections.find(conn =>
      conn.providerType === 'openai_compat' && isMoonshotConnection(conn)
    )
    if (moonshotConn) return moonshotConn.slug
  }

  return undefined
}

const VALID_TEAM_ROLES: ReadonlySet<TeamRole> = new Set(['lead', 'head', 'worker', 'reviewer', 'escalation'])

function normalizeTeamRole(rawRole?: string): TeamRole {
  if (!rawRole) return 'worker'
  if (VALID_TEAM_ROLES.has(rawRole as TeamRole)) return rawRole as TeamRole
  return 'worker'
}

// Codename generation functions moved to ./teammate-codenames.ts for testability

function formatPercentScore(score: number): string {
  const normalized = Math.max(0, Math.min(100, Math.round(score)))
  return `${normalized}%`
}

function qualityStageLabel(stage: string): string {
  const labels: Record<string, string> = {
    syntax: 'Syntax & Types',
    tests: 'Tests',
    architecture: 'Architecture',
    simplicity: 'Simplicity',
    errors: 'Error Handling',
    completeness: 'Completeness',
    spec_compliance: 'Spec Compliance',
    traceability: 'Traceability',
    rollout_safety: 'Rollout Safety',
  }
  return labels[stage] ?? stage
}

function qualityStageSummaryLines(result: QualityGateResult): string[] {
  const orderedStages = [
    'syntax',
    'tests',
    'architecture',
    'simplicity',
    'errors',
    'completeness',
    'spec_compliance',
    'traceability',
    'rollout_safety',
  ] as const

  const lines: string[] = []
  for (const stageName of orderedStages) {
    const stage = result.stages[stageName]
    if (!stage) continue
    const icon = stage.passed ? '✅' : '❌'
    if (stageName === 'tests') {
      const tests = stage as typeof result.stages.tests
      lines.push(
        `- ${icon} ${qualityStageLabel(stageName)}: ${formatPercentScore(stage.score)} (${tests.passedTests}/${tests.totalTests} passed)`
      )
      continue
    }
    lines.push(`- ${icon} ${qualityStageLabel(stageName)}: ${formatPercentScore(stage.score)}`)
  }
  return lines
}

function buildQualityLeadSummary(
  teammateName: string,
  result: QualityGateResult,
  status: 'passed' | 'failed' | 'escalated',
): string {
  const statusLabel = status === 'passed' ? 'PASSED' : status === 'escalated' ? 'ESCALATED' : 'FAILED'
  const icon = status === 'passed' ? '✅' : status === 'escalated' ? '🚨' : '⚠️'
  const lines = [
    `### ${icon} Quality Gate ${statusLabel}`,
    `Teammate: ${teammateName}`,
    `Overall Score: ${formatPercentScore(result.aggregateScore)}`,
    `Review Cycle: ${result.cycleCount}/${result.maxCycles}`,
    '',
    '**Phase Scoreboard**',
    ...qualityStageSummaryLines(result),
  ]
  return lines.join('\n')
}

function buildWorkerQualityFeedback(result: QualityGateResult, maxCycles: number): string {
  const lines = [
    `## Quality Gate Feedback`,
    `Cycle ${result.cycleCount}/${maxCycles}`,
    `Overall score: ${formatPercentScore(result.aggregateScore)}`,
    '',
    '**Phase Scoreboard**',
    ...qualityStageSummaryLines(result),
    '',
    'Please fix failing phases first, then re-run.',
  ]
  return lines.join('\n')
}

function formatHealthAlertMessage(issue: HealthIssue): string {
  const typeLabel = issue.type === 'stall'
    ? 'STALL'
    : issue.type === 'error-loop'
      ? 'ERROR LOOP'
      : issue.type === 'retry-storm'
        ? 'RETRY STORM'
        : 'CONTEXT EXHAUSTION'
  return [
    `### ⚠️ Team Health Alert (${typeLabel})`,
    `Teammate: ${issue.teammateName}`,
    `Issue: ${issue.details}`,
  ].join('\n')
}

// teammateMatchesTargetName moved to ./teammate-codenames.ts for testability

const execFileAsync = promisify(execFile)

interface RuntimeProcessRow {
  pid: number
  parentPid?: number
  name: string
  commandLine: string
  createdAt?: string
}

function commandPreview(commandLine: string): string {
  const compact = commandLine.replace(/\s+/g, ' ').trim()
  return compact.length > 220 ? `${compact.slice(0, 220)}…` : compact
}

function extractSessionIdFromCommand(commandLine: string): string | undefined {
  if (!commandLine) return undefined

  // Explicit CLI flag (preferred)
  const flagMatch = commandLine.match(/--session-id(?:=|\s+)(["']?)([a-z0-9][a-z0-9-]{5,})\1/i)
  if (flagMatch?.[2]) return flagMatch[2]

  // Session directory path fallback (.../sessions/<session-id>/...)
  const pathMatch = commandLine.match(/[\\/]sessions[\\/](?<id>[a-z0-9][a-z0-9-]{5,})/i)
  const pathId = pathMatch?.groups?.id
  if (pathId) return pathId

  return undefined
}

/**
 * Feature flags for agent behavior
 */
export const AGENT_FLAGS = {
  /** Default modes enabled for new sessions */
  defaultModesEnabled: true,
} as const

/** Predefined team colors — high-contrast, accessible palette. Rotates by active team count. */
const TEAM_COLORS = [
  '#7c3aed', // violet
  '#0891b2', // cyan
  '#c2410c', // orange
  '#15803d', // green
  '#b91c1c', // red
  '#1d4ed8', // blue
  '#a16207', // amber
  '#9333ea', // purple
  '#0f766e', // teal
  '#be185d', // pink
] as const

function extractSectionLines(lines: string[], heading: string): string[] {
  const startIndex = lines.findIndex(line => line.trim().toLowerCase() === heading.toLowerCase())
  if (startIndex === -1) return []
  const sectionLines: string[] = []
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim().startsWith('## ')) break
    sectionLines.push(line)
  }
  return sectionLines
}

function parsePriority(raw?: string): SpecRequirement['priority'] {
  switch ((raw ?? '').toLowerCase()) {
    case 'critical':
      return 'critical'
    case 'high':
      return 'high'
    case 'low':
      return 'low'
    default:
      return 'medium'
  }
}

function parseStatus(raw?: string): SpecRequirement['status'] {
  switch ((raw ?? '').trim().toLowerCase()) {
    case 'in-progress':
      return 'in-progress'
    case 'implemented':
      return 'implemented'
    case 'verified':
      return 'verified'
    default:
      return 'pending'
  }
}

export function parseSpecMarkdown(markdown: string, specId: string): Spec {
  const lines = markdown.split(/\r?\n/)
  const titleLine = lines.find(line => line.trim().startsWith('# ')) ?? '# Untitled Spec'
  const title = titleLine.replace(/^#\s*/, '').trim()
  const ownerMatch = lines.find(line => /DRI:/i.test(line))?.match(/DRI:\s*([^<]+)$/i)
  const ownerDRI = ownerMatch?.[1]?.trim() ?? 'Unassigned'

  const goals = extractSectionLines(lines, '## Goals')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean)
  const nonGoals = extractSectionLines(lines, '## Non-Goals')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean)
  const acceptanceTests = extractSectionLines(lines, '## Acceptance Tests')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean)
  const riskLines = extractSectionLines(lines, '## Risks')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean)

  const requirementLines = extractSectionLines(lines, '## Requirements')
    .map(line => line.trim())
    .filter(line => line.startsWith('-'))
  const requirements: SpecRequirement[] = requirementLines.map((line, index) => {
    const match = line.match(/\*\*(REQ-[0-9]+)\s*\(([^)]+)\):\*\*\s*(.+)$/i)
    if (match) {
      const metaParts = match[2].split(',').map(part => part.trim()).filter(Boolean)
      const priorityToken = metaParts.find(part => ['critical', 'high', 'medium', 'low'].includes(part.toLowerCase()))
      const statusToken = metaParts.find(part => part.toLowerCase().startsWith('status:'))
      const statusValue = statusToken ? statusToken.split(':').slice(1).join(':').trim() : undefined
      return {
        id: match[1].trim(),
        description: match[3].trim(),
        priority: parsePriority(priorityToken ?? match[2]),
        acceptanceTests,
        assignedDRI: ownerDRI,
        status: parseStatus(statusValue),
      }
    }
    return {
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      description: line.replace(/^[\s*-]+/, ''),
      priority: 'medium',
      acceptanceTests,
      assignedDRI: ownerDRI,
      status: 'pending',
    }
  })

  const risks: SpecRisk[] = riskLines.map((risk, index) => ({
    id: `RISK-${String(index + 1).padStart(3, '0')}`,
    description: risk,
    severity: 'medium',
    mitigation: '',
    status: 'identified',
  }))

  const rolloutPlan = extractSectionLines(lines, '## Rollout Plan').join('\n').trim() || undefined
  const rollbackPlan = extractSectionLines(lines, '## Rollback Plan').join('\n').trim() || undefined
  const observabilityPlan = extractSectionLines(lines, '## Observability Plan').join('\n').trim() || undefined

  const timestamp = new Date().toISOString()
  return {
    specId,
    title,
    ownerDRI,
    reviewers: [],
    status: 'in-progress',
    goals,
    nonGoals,
    requirements,
    risks,
    mitigations: [],
    rolloutPlan,
    rollbackPlan,
    testPlan: acceptanceTests.join('\n') || undefined,
    observabilityPlan,
    relatedTickets: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function updateRequirementStatusInMarkdown(
  markdown: string,
  requirementId: string,
  status: 'pending' | 'in-progress' | 'implemented' | 'verified'
): string {
  const lines = markdown.split(/\r?\n/)
  const requirementPattern = new RegExp(`^\\s*-\\s*\\*\\*(${requirementId})\\s*\\(([^)]*)\\):\\*\\*\\s*(.+)$`, 'i')
  const updatedLines = lines.map((line) => {
    const match = line.match(requirementPattern)
    if (!match) return line
    const metaParts = match[2].split(',').map((part) => part.trim()).filter(Boolean)
    const statusIndex = metaParts.findIndex((part) => part.toLowerCase().startsWith('status:'))
    if (statusIndex >= 0) {
      metaParts[statusIndex] = `status: ${status}`
    } else {
      metaParts.push(`status: ${status}`)
    }
    const meta = metaParts.join(', ')
    return `- **${match[1]} (${meta}):** ${match[3]}`
  })
  return updatedLines.join('\n')
}

const DEFAULT_SPEC_REQUIREMENTS = [
  'Define the primary user flow and key success criteria.',
  'Document data inputs/outputs and persistence needs.',
  'Outline performance, reliability, and security expectations.',
]

const DEFAULT_SPEC_SECTIONS = [
  'Overview',
  'Objective',
  'Success Metrics',
  'Assumptions',
  'Options / Decisions',
  'Requirements',
  'Acceptance Tests',
  'Risks',
  'Supporting Docs',
  'Open Questions',
  'Out of Scope',
  'Rollout Plan',
  'Rollback Plan',
  'Observability Plan',
]

export function buildSpecMarkdown(options: {
  title: string
  ownerDRI: string
  template?: SpecTemplate
}): string {
  const { title, ownerDRI, template } = options
  const lines: string[] = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push(`**DRI:** ${ownerDRI}`)
  lines.push('')
  lines.push('> Auto-generated spec template. Fill in the details before executing work.')
  lines.push('')

  const sections = template?.sections?.length
    ? template.sections.map(section => section.label)
    : DEFAULT_SPEC_SECTIONS

  const requirementPriority = template?.defaultRequirementPriority ?? 'medium'
  let requirementIndex = 1
  let riskIndex = 1

  for (const sectionLabel of sections) {
    lines.push(`## ${sectionLabel}`)
    lines.push('')

    const normalized = sectionLabel.trim().toLowerCase()
    if (normalized.includes('overview')) {
      lines.push('| Field | Value |')
      lines.push('| --- | --- |')
      lines.push('| Status | Draft |')
      lines.push(`| Owner DRI | ${ownerDRI} |`)
      lines.push('| Reviewers | TBD |')
      lines.push('| Target Release | TBD |')
      lines.push(`| Last Updated | ${new Date().toISOString().split('T')[0]} |`)
    } else if (normalized.includes('objective')) {
      lines.push('Describe the primary objective and expected impact.')
    } else if (normalized.includes('success metrics') || normalized.includes('success')) {
      lines.push('| Metric | Target | Owner |')
      lines.push('| --- | --- | --- |')
      lines.push('| TBD | TBD | TBD |')
    } else if (normalized.includes('assumption')) {
      lines.push('- List assumptions that must hold true.')
    } else if (normalized.includes('options')) {
      lines.push('| Option | Decision | Notes |')
      lines.push('| --- | --- | --- |')
      lines.push('| TBD | TBD | TBD |')
    } else if (normalized.includes('requirement')) {
      DEFAULT_SPEC_REQUIREMENTS.forEach((req) => {
        lines.push(`- **REQ-${String(requirementIndex).padStart(3, '0')} (${requirementPriority}):** ${req}`)
        requirementIndex += 1
      })
    } else if (normalized.includes('risk')) {
      lines.push(`- **RISK-${String(riskIndex).padStart(3, '0')} (medium):** Describe the risk and mitigation.`)
      riskIndex += 1
    } else if (normalized.includes('acceptance')) {
      lines.push('- Define clear acceptance tests or success metrics.')
    } else if (normalized.includes('supporting') || normalized.includes('docs')) {
      lines.push('- Link to designs, diagrams, or reference docs.')
    } else if (normalized.includes('open question')) {
      lines.push('- List unanswered questions or dependencies.')
    } else if (normalized.includes('out of scope')) {
      lines.push('- Explicitly list non-goals or exclusions.')
    } else if (normalized.includes('rollout')) {
      lines.push('Describe rollout steps, feature flags, and monitoring.')
    } else if (normalized.includes('rollback')) {
      lines.push('Describe rollback steps and fallback behavior.')
    } else if (normalized.includes('observability') || normalized.includes('monitoring')) {
      lines.push('List logs, metrics, and alerts needed to validate success.')
    } else {
      lines.push('- TODO')
    }

    lines.push('')
  }

  return lines.join('\n').trim() + '\n'
}

export function buildTeammatePromptWithCompactSpec(
  prompt: string,
  compactSpecContext?: string | null
): string {
  if (compactSpecContext && compactSpecContext.trim().length > 0) {
    return `${prompt}\n\n<compact_spec>\n${compactSpecContext}\n</compact_spec>`
  }
  return prompt
}

export function resolveQualityGateReviewInput(
  reviewDiff: Pick<ReviewDiff, 'unifiedDiff'> | null,
): { reviewInput: string; usesGitDiff: boolean; failureReason?: string } {
  const unifiedDiff = reviewDiff?.unifiedDiff?.trim() ?? ''
  if (unifiedDiff.length > 0) {
    return {
      reviewInput: reviewDiff!.unifiedDiff,
      usesGitDiff: true,
    }
  }

  return {
    reviewInput: '',
    usesGitDiff: false,
    failureReason: 'No verifiable git diff was found for this teammate run. Quality gates require real code diffs and cannot rely on assistant prose alone.',
  }
}

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 */
async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // Load credentials for all sources
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  // Build token getter for OAuth sources (Google, Slack, Microsoft use OAuth)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    if (isApiOAuthProvider(provider)) {
      // Use TokenRefreshManager if provided, otherwise create temporary one
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sessionLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(sourcesWithCreds, getTokenForSource, sessionPath, summarize)
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state
  for (const error of result.errors) {
    if (error.error === SERVER_BUILD_ERRORS.AUTH_REQUIRED) {
      const source = sources.find(s => s.config.slug === error.sourceSlug)
      if (source) {
        credManager.markSourceNeedsReauth(source, 'Token missing or expired')
        sessionLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
      }
    }
  }

  span.end()
  return result
}

/**
 * Result of OAuth token refresh operation.
 */
interface OAuthTokenRefreshResult {
  /** Whether any tokens were refreshed (configs were updated) */
  tokensRefreshed: boolean
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Refresh expired OAuth tokens and rebuild server configs.
 * Uses TokenRefreshManager for unified refresh logic (DRY/SOLID principles).
 *
 * This implements "proactive refresh at query time" - tokens are refreshed before
 * each agent.chat() call, then server configs are rebuilt with fresh headers.
 *
 * Handles both:
 * - MCP OAuth sources (e.g., Linear, Notion)
 * - API OAuth sources (Google, Slack, Microsoft)
 *
 * @param agent - The agent to update server configs on
 * @param sources - All loaded sources for the session
 * @param sessionPath - Path to session folder for API response storage
 * @param tokenRefreshManager - TokenRefreshManager instance for this session
 */
async function refreshOAuthTokensIfNeeded(
  agent: AgentInstance,
  sources: LoadedSource[],
  sessionPath: string,
  tokenRefreshManager: TokenRefreshManager
): Promise<OAuthTokenRefreshResult> {
  sessionLog.debug('[OAuth] Checking if any OAuth tokens need refresh')

  // Use TokenRefreshManager to find sources needing refresh (handles rate limiting)
  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)

  if (needRefresh.length === 0) {
    return { tokensRefreshed: false, failedSources: [] }
  }

  sessionLog.debug(`[OAuth] Found ${needRefresh.length} source(s) needing token refresh: ${needRefresh.map(s => s.config.slug).join(', ')}`)

  // Use TokenRefreshManager to refresh all tokens (handles rate limiting and error tracking)
  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  // Convert failed results to the expected format
  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  if (refreshed.length > 0) {
    // Rebuild server configs with fresh tokens
    sessionLog.debug(`[OAuth] Rebuilding servers after ${refreshed.length} token refresh(es)`)
    const enabledSources = sources.filter(s => isSourceUsable(s))
    const { mcpServers, apiServers } = await buildServersFromSources(
      enabledSources,
      sessionPath,
      tokenRefreshManager,
      agent.getSummarizeCallback()
    )
    const intendedSlugs = enabledSources.map(s => s.config.slug)
    agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
    return { tokensRefreshed: true, failedSources }
  }

  return { tokensRefreshed: false, failedSources }
}

/**
 * Write a file with restricted permissions atomically.
 *
 * This avoids TOCTOU (Time-of-Check-Time-of-Use) race conditions where the file
 * could be read with default permissions between write and chmod.
 *
 * Strategy: Open file with O_CREAT|O_EXCL and mode 0o600, write, close, rename.
 *
 * @param targetPath - Final path for the file
 * @param content - Content to write
 * @param mode - File permissions (default: 0o600 - owner read/write only)
 */
async function writeFileSecure(targetPath: string, content: string, mode: number = 0o600): Promise<void> {
  // Write to temp file with correct permissions from the start
  const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`

  // Open with O_CREAT | O_WRONLY | O_EXCL ensures atomic creation with mode
  // Node.js 'wx' flag is O_WRONLY | O_CREAT | O_EXCL
  const fd = await open(tempPath, 'wx', mode)
  try {
    await fd.writeFile(content, 'utf-8')
  } finally {
    await fd.close()
  }

  // Atomic rename to final path
  await rename(tempPath, targetPath)
}

/**
 * Set up Codex session configuration.
 * Creates .codex-home directory with config.toml for per-session MCP server configuration.
 *
 * @param sessionPath - Path to the session folder
 * @param sources - Enabled sources for this session
 * @param mcpServerConfigs - Pre-built MCP server configs (from buildServersFromSources)
 * @param sessionId - Session ID for session-scoped tools
 * @param workspaceRootPath - Workspace root path for session-scoped tools
 * @returns Path to the CODEX_HOME directory
 */
async function setupCodexSessionConfig(
  sessionPath: string,
  sources: LoadedSource[],
  mcpServerConfigs: Record<string, import('@craft-agent/shared/agent/backend').SdkMcpServerConfig>,
  sessionId?: string,
  workspaceRootPath?: string
): Promise<string> {
  const codexHome = join(sessionPath, '.codex-home')

  // Create .codex-home directory
  await mkdir(codexHome, { recursive: true })

  // Generate config.toml with enabled sources
  // Bridge server path differs between packaged app and development:
  // - Packaged: resources/bridge-mcp-server/index.js (copied during build)
  // - Dev: packages/bridge-mcp-server/dist/index.js (built by electron:build:main)
  //   Fallback: apps/electron/resources/bridge-mcp-server/index.js (pre-built bundle from upstream)
  let bridgeServerPath = app.isPackaged
    ? join(app.getAppPath(), 'resources', 'bridge-mcp-server', 'index.js')
    : join(process.cwd(), 'packages', 'bridge-mcp-server', 'dist', 'index.js')
  if (!app.isPackaged && !existsSync(bridgeServerPath)) {
    const fallback = join(process.cwd(), 'apps', 'electron', 'resources', 'bridge-mcp-server', 'index.js')
    if (existsSync(fallback)) { bridgeServerPath = fallback }
  }
  const bridgeConfigPath = join(sessionPath, '.codex-home', 'bridge-config.json')

  // Session MCP server path - provides session-scoped tools (SubmitPlan, config_validate, etc.)
  // - Packaged: resources/session-mcp-server/index.js (copied during build)
  // - Dev: packages/session-mcp-server/dist/index.js (built by electron:build:main)
  //   Fallback: apps/electron/resources/session-mcp-server/index.js (pre-built bundle from upstream)
  let sessionServerPath = app.isPackaged
    ? join(app.getAppPath(), 'resources', 'session-mcp-server', 'index.js')
    : join(process.cwd(), 'packages', 'session-mcp-server', 'dist', 'index.js')
  if (!app.isPackaged && !existsSync(sessionServerPath)) {
    const fallback = join(process.cwd(), 'apps', 'electron', 'resources', 'session-mcp-server', 'index.js')
    if (existsSync(fallback)) { sessionServerPath = fallback }
  }

  // Check if bridge server exists - if not, log warning and skip bridge config
  // This enables graceful degradation when bridge isn't built (e.g., fresh clone)
  const bridgeExists = existsSync(bridgeServerPath)
  if (!bridgeExists) {
    sessionLog.warn(`Bridge MCP server not found at ${bridgeServerPath}. API sources will not be available in Codex sessions. Run 'bun run electron:build' to build it.`)
  }

  // Check if session server exists
  const sessionServerExists = existsSync(sessionServerPath)
  if (!sessionServerExists) {
    sessionLog.warn(`Session MCP server not found at ${sessionServerPath}. Session-scoped tools (SubmitPlan, etc.) will not be available in Codex sessions. Run 'bun run electron:build' to build it.`)
  }

  // Extract workspaceId from first source (all sources in a session share the same workspace)
  const workspaceId = sources[0]?.workspaceId

  // Plans folder path for SubmitPlan tool
  const plansFolderPath = sessionId && workspaceRootPath
    ? join(workspaceRootPath, 'sessions', sessionId, 'plans')
    : undefined

  const configResult = generateCodexConfig({
    sources,
    mcpServerConfigs,
    sessionPath,
    // Bridge server enables API sources (Gmail, Slack, etc.) via stdio MCP
    // Only include if the bridge server actually exists
    bridgeServerPath: bridgeExists ? bridgeServerPath : undefined,
    bridgeConfigPath: bridgeExists ? bridgeConfigPath : undefined,
    // workspaceId is required for the bridge's --workspace flag (credential lookups)
    workspaceId,
    // Session server provides session-scoped tools (SubmitPlan, config_validate, etc.)
    // Only include if the session server exists and we have the required session info
    sessionServerPath: sessionServerExists && sessionId && workspaceRootPath ? sessionServerPath : undefined,
    sessionId,
    workspaceRootPath,
    plansFolderPath,
    // Use bundled Bun in packaged app, system 'bun' in development
    // IMPORTANT: process.execPath returns the Electron binary in packaged apps, which cannot run JS files
    nodePath: getBundledBunPath() ?? 'bun',
  })

  // Write config.toml
  await writeFile(join(codexHome, 'config.toml'), configResult.toml, 'utf-8')
  sessionLog.info(`Generated Codex config: ${configResult.mcpSources.length} MCP sources, ${configResult.apiSources.length} API sources`)

  // Log warnings for sources that couldn't be configured
  for (const warning of configResult.warnings) {
    sessionLog.warn(`Source config warning [${warning.sourceSlug}]: ${warning.message}`)
  }

  // If we have API sources, generate bridge config and write credential cache files
  if (configResult.needsBridge) {
    const bridgeConfig = generateBridgeConfig(sources)
    await writeFile(join(codexHome, 'bridge-config.json'), bridgeConfig, 'utf-8')

    // Write credential cache files for the bridge server to read
    const credManager = getSourceCredentialManager()
    for (const source of sources.filter(s => s.config.type === 'api' && s.config.enabled)) {
      const cred = await credManager.load(source)
      if (cred?.value) {
        const cachePath = getCredentialCachePath(source.workspaceRootPath, source.config.slug)
        const cacheEntry: CredentialCacheEntry = {
          value: cred.value,
          expiresAt: cred.expiresAt,
        }
        // Ensure source directory exists
        await mkdir(join(source.workspaceRootPath, 'sources', source.config.slug), { recursive: true })
        // Use atomic write to avoid TOCTOU - file never exists with wrong permissions
        await writeFileSecure(cachePath, JSON.stringify(cacheEntry), 0o600)
      }
    }
  }

  return codexHome
}

/**
 * Write bridge-config.json and credential cache files for Copilot API sources.
 * Mirrors the bridge setup in setupCodexSessionConfig() but without TOML generation —
 * Copilot passes MCP config directly at session creation via buildMcpConfig().
 *
 * Called before setSourceServers() so the bridge MCP server subprocess can read them
 * when the session is created on the next chat() call.
 */
async function setupCopilotBridgeConfig(
  copilotConfigDir: string,
  sources: LoadedSource[],
): Promise<void> {
  const apiSources = sources.filter(s => s.config.type === 'api' && s.config.enabled)
  if (apiSources.length === 0) return

  // Ensure config directory exists
  await mkdir(copilotConfigDir, { recursive: true })

  // Generate bridge config JSON (same format as Codex)
  const bridgeConfig = generateBridgeConfig(sources)
  await writeFile(join(copilotConfigDir, 'bridge-config.json'), bridgeConfig, 'utf-8')

  // Write credential cache files for the bridge server to read
  const credManager = getSourceCredentialManager()
  for (const source of apiSources) {
    const cred = await credManager.load(source)
    if (cred?.value) {
      const cachePath = getCredentialCachePath(source.workspaceRootPath, source.config.slug)
      const cacheEntry: CredentialCacheEntry = {
        value: cred.value,
        expiresAt: cred.expiresAt,
      }
      await mkdir(join(source.workspaceRootPath, 'sources', source.config.slug), { recursive: true })
      await writeFileSecure(cachePath, JSON.stringify(cacheEntry), 0o600)
    }
  }

  sessionLog.info(`Copilot bridge config written: ${apiSources.length} API sources`)
}

/**
 * Resolve the path to the bridge MCP server executable.
 * Same binary is shared between Codex and Copilot backends.
 */
function resolveBridgeServerPath(): { path: string; exists: boolean } {
  const bridgeServerPath = app.isPackaged
    ? join(app.getAppPath(), 'resources', 'bridge-mcp-server', 'index.js')
    : join(process.cwd(), 'packages', 'bridge-mcp-server', 'dist', 'index.js')
  return { path: bridgeServerPath, exists: existsSync(bridgeServerPath) }
}

/**
 * Resolve tool display metadata for a tool call.
 * Returns metadata with base64-encoded icon for viewer compatibility.
 *
 * @param toolName - Tool name from the event (e.g., "Skill", "mcp__linear__list_issues")
 * @param toolInput - Tool input (used for Skill tool to get skill identifier)
 * @param workspaceRootPath - Path to workspace for loading skills/sources
 * @param sources - Loaded sources for the workspace
 */
function resolveToolDisplayMeta(
  toolName: string,
  toolInput: Record<string, unknown> | undefined,
  workspaceRootPath: string,
  sources: LoadedSource[]
): ToolDisplayMeta | undefined {
  // Check if it's an MCP tool (format: mcp__<serverSlug>__<toolName>)
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__')
    if (parts.length >= 3) {
      const serverSlug = parts[1]
      const toolSlug = parts.slice(2).join('__')

      // Internal MCP server tools (session, preferences, docs)
      const internalMcpServers: Record<string, Record<string, string>> = {
        'session': {
          'SubmitPlan': 'Submit Plan',
          'config_validate': 'Validate Config',
          'skill_validate': 'Validate Skill',
          'mermaid_validate': 'Validate Mermaid',
          'source_test': 'Test Source',
          'source_oauth_trigger': 'OAuth',
          'source_google_oauth_trigger': 'Google Auth',
          'source_slack_oauth_trigger': 'Slack Auth',
          'source_microsoft_oauth_trigger': 'Microsoft Auth',
          'source_credential_prompt': 'Enter Credentials',
        },
        'preferences': {
          'update_user_preferences': 'Update Preferences',
        },
        'craft-agents-docs': {
          'SearchCraftAgents': 'Search Docs',
        },
      }

      const internalServer = internalMcpServers[serverSlug]
      if (internalServer) {
        const displayName = internalServer[toolSlug]
        if (displayName) {
          return {
            displayName,
            category: 'native' as const,
          }
        }
      }

      // External source tools
      let sourceSlug = serverSlug

      // Special case: api-bridge server embeds source slug in tool name as "api_{slug}"
      // e.g., mcp__api-bridge__api_stripe → sourceSlug = "stripe"
      if (sourceSlug === 'api-bridge' && toolSlug.startsWith('api_')) {
        sourceSlug = toolSlug.slice(4)
      }

      const source = sources.find(s => s.config.slug === sourceSlug)
      if (source) {
        // Try file-based icon first, fall back to emoji icon from config
        const iconDataUrl = source.iconPath
          ? encodeIconToDataUrl(source.iconPath)
          : getEmojiIcon(source.config.icon)
        return {
          displayName: source.config.name,
          iconDataUrl,
          description: source.config.tagline,
          category: 'source' as const,
        }
      }
    }
    return undefined
  }

  // Check if it's the Skill tool
  if (toolName === 'Skill' && toolInput) {
    // Skill input has 'skill' param with format: "skillSlug" or "workspaceId:skillSlug"
    const skillParam = toolInput.skill as string | undefined
    if (skillParam) {
      // Extract skill slug (remove workspace prefix if present)
      const skillSlug = skillParam.includes(':') ? skillParam.split(':').pop() : skillParam
      if (skillSlug) {
        // Load skills and find the one being invoked
        try {
          const skills = loadWorkspaceSkills(workspaceRootPath)
          const skill = skills.find(s => s.slug === skillSlug)
          if (skill) {
            // Try file-based icon first, fall back to emoji icon from metadata
            const iconDataUrl = skill.iconPath
              ? encodeIconToDataUrl(skill.iconPath)
              : getEmojiIcon(skill.metadata.icon)
            return {
              displayName: skill.metadata.name,
              iconDataUrl,
              description: skill.metadata.description,
              category: 'skill' as const,
            }
          }
        } catch {
          // Skills loading failed, skip
        }
      }
    }
    return undefined
  }

  // CLI tool icon resolution for Bash commands
  // Parses the command string to detect known tools (git, npm, docker, etc.)
  // and resolves their brand icon from ~/.craft-agent/tool-icons/
  if (toolName === 'Bash' && toolInput?.command) {
    const toolIconsDir = getToolIconsDir()
    const match = resolveToolIcon(String(toolInput.command), toolIconsDir)
    if (match) {
      return {
        displayName: match.displayName,
        iconDataUrl: match.iconDataUrl,
        category: 'native' as const,
      }
    }
  }

  // Native tool display names (no icons - UI handles these with built-in icons)
  // This ensures toolDisplayMeta is always populated for consistent display
  const nativeToolNames: Record<string, string> = {
    'Read': 'Read',
    'Write': 'Write',
    'Edit': 'Edit',
    'Bash': 'Terminal',
    'Grep': 'Search',
    'Glob': 'Find Files',
    'Task': 'Agent',
    'WebFetch': 'Fetch URL',
    'WebSearch': 'Web Search',
    'TodoWrite': 'Update Todos',
    'NotebookEdit': 'Edit Notebook',
    'KillShell': 'Kill Shell',
    'TaskOutput': 'Task Output',
  }

  const nativeDisplayName = nativeToolNames[toolName]
  if (nativeDisplayName) {
    return {
      displayName: nativeDisplayName,
      category: 'native' as const,
    }
  }

  // Unknown tool - no display metadata (will fall back to tool name in UI)
  return undefined
}

/** Agent type - CraftAgent for Claude, CodexBackend for Codex, CopilotAgent for Copilot */
type AgentInstance = CraftAgent | CodexBackend | CopilotAgent

interface ManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null  // Lazy-loaded - null until first message
  messages: Message[]
  isProcessing: boolean
  /** Set when user requests stop - allows event loop to drain before clearing isProcessing */
  stopRequested?: boolean
  lastMessageAt: number
  streamingText: string
  // Incremented each time a new message starts processing.
  // Used to detect if a follow-up message has superseded the current one (stale-request guard).
  processingGeneration: number
  // NOTE: Parent-child tracking state (pendingTools, parentToolStack, toolToParentMap,
  // pendingTextParent) has been removed. CraftAgent now provides parentToolUseId
  // directly on all events using the SDK's authoritative parent_tool_use_id field.
  // See: packages/shared/src/agent/tool-matching.ts
  // Session name (user-defined or AI-generated)
  name?: string
  isFlagged: boolean
  /** Whether this session is archived */
  isArchived?: boolean
  /** Timestamp when session was archived (for retention policy) */
  archivedAt?: number
  /** Permission mode for this session ('safe', 'ask', 'allow-all') */
  permissionMode?: PermissionMode
  // SDK session ID for conversation continuity
  sdkSessionId?: string
  // Token usage for display
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    /** Model's context window size in tokens (from SDK modelUsage) */
    contextWindow?: number
  }
  // Todo state (user-controlled) - determines open vs closed
  // Dynamic status ID referencing workspace status config
  todoState?: string
  // Read/unread tracking - ID of last message user has read
  lastReadMessageId?: string
  /**
   * Explicit unread flag - single source of truth for NEW badge.
   * Set to true when assistant message completes while user is NOT viewing.
   * Set to false when user views the session (and not processing).
   */
  hasUnread?: boolean
  // Per-session source selection (slugs of enabled sources)
  enabledSourceSlugs?: string[]
  // Labels applied to this session (additive tags, many-per-session)
  labels?: string[]
  // Working directory for this session (used by agent for bash commands)
  workingDirectory?: string
  // SDK cwd for session storage - set once at creation, never changes.
  // Ensures SDK can find session transcripts regardless of workingDirectory changes.
  sdkCwd?: string
  // Shared viewer URL (if shared via viewer)
  sharedUrl?: string
  // Shared session ID in viewer (for revoke)
  sharedId?: string
  // Model to use for this session (overrides global config if set)
  model?: string
  // Canonical provider used for usage tracking and pricing
  llmProvider?: UsageProvider
  // LLM connection slug for this session (locked after first message)
  llmConnection?: string
  // Whether the connection is locked (cannot be changed after first agent creation)
  connectionLocked?: boolean
  // Thinking level for this session ('off', 'think', 'max')
  thinkingLevel?: ThinkingLevel
  // System prompt preset for mini agents ('default' | 'mini')
  systemPromptPreset?: 'default' | 'mini' | string
  // Role/type of the last message (for badge display without loading messages)
  lastMessageRole?: 'user' | 'assistant' | 'plan' | 'tool' | 'error'
  // ID of the last final (non-intermediate) assistant message - pre-computed for unread detection
  lastFinalMessageId?: string
  // Whether an async operation is ongoing (sharing, updating share, revoking, title regeneration)
  // Used for shimmer effect on session title
  isAsyncOperationOngoing?: boolean
  // Preview of first user message (for sidebar display fallback)
  preview?: string
  // When the session was first created (ms timestamp from JSONL header)
  createdAt?: number
  // Total message count (pre-computed in JSONL header for fast list loading)
  messageCount?: number
  // Message queue for handling new messages while processing
  // When a message arrives during processing, we interrupt and queue
  messageQueue: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string  // Pre-generated ID for matching with UI
    optimisticMessageId?: string  // Frontend's ID for reliable event matching
  }>
  // Map of shellId -> command for killing background shells
  backgroundShellCommands: Map<string, string>
  // Whether messages have been loaded from disk (for lazy loading)
  messagesLoaded: boolean
  // Pending auth request tracking (for unified auth flow)
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  // Auth retry tracking (for mid-session token expiry)
  // Store last sent message/attachments to enable retry after token refresh
  lastSentMessage?: string
  lastSentAttachments?: FileAttachment[]
  lastSentStoredAttachments?: StoredAttachment[]
  lastSentOptions?: SendMessageOptions
  // Flag to prevent infinite retry loops (reset at start of each sendMessage)
  authRetryAttempted?: boolean
  // Flag indicating auth retry is in progress (to prevent complete handler from interfering)
  authRetryInProgress?: boolean
  // Flag to prevent infinite retry loops when Codex app-server disconnects mid-turn
  connectionRetryAttempted?: boolean
  // Flag indicating reconnect retry is in progress (to prevent premature completion cleanup)
  connectionRetryInProgress?: boolean
  // Whether this session is hidden from session list (e.g., mini edit sessions)
  hidden?: boolean
  // Sub-session hierarchy (1 level max)
  parentSessionId?: string
  siblingOrder?: number
  // Agent team fields
  teamId?: string
  isTeamLead?: boolean
  teammateName?: string
  teammateSessionIds?: string[]
  teamColor?: string
  // SDD fields
  sddEnabled?: boolean
  activeSpecId?: string
  sddComplianceReports?: SpecComplianceReport[]
  // Token refresh manager for OAuth token refresh with rate limiting
  tokenRefreshManager: TokenRefreshManager
  // Multi-provider usage tracking summary for this session
  usageSummary?: SessionUsage
  // Deduplication: track last sent message content and timestamp to prevent double-sends
  // (renderer sometimes sends the same message twice within ~100-200ms)
  lastSendDedup?: { content: string; timestamp: number }
  // Metadata for sessions created by hooks (automation)
  triggeredBy?: { hookName?: string; event?: string; timestamp?: number }
  // Promise that resolves when the agent instance is ready (for title gen to await)
  agentReady?: Promise<void>
  agentReadyResolve?: () => void
}

function createEmptyProviderUsage(): ProviderUsage {
  return {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
  }
}

function getISOWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
}

function createEmptySessionUsage(sessionId: string, startedAtMs: number): SessionUsage {
  const nowIso = new Date().toISOString()
  const date = new Date(startedAtMs || Date.now())
  const weekNumber = getISOWeekNumber(date)

  return {
    sessionId,
    startedAt: new Date(startedAtMs || Date.now()).toISOString(),
    lastUpdatedAt: nowIso,
    weekIdentifier: `${date.getFullYear()}-W${String(weekNumber).padStart(2, '0')}`,
    providers: {
      anthropic: createEmptyProviderUsage(),
      openai: createEmptyProviderUsage(),
      moonshot: createEmptyProviderUsage(),
      openrouter: createEmptyProviderUsage(),
    },
    totalCalls: 0,
    totalDurationMs: 0,
  }
}

type UsageProviderKey = 'anthropic' | 'openai' | 'moonshot' | 'openrouter'

// Convert runtime Message to StoredMessage for persistence
// Only excludes transient field: isStreaming
function messageToStored(msg: Message): StoredMessage {
  return {
    id: msg.id,
    type: msg.role,  // Message uses 'role', StoredMessage uses 'type'
    content: msg.content,
    timestamp: msg.timestamp,
    // Tool fields
    toolName: msg.toolName,
    toolUseId: msg.toolUseId,
    toolInput: msg.toolInput,
    toolResult: msg.toolResult,
    toolStatus: msg.toolStatus,
    toolDuration: msg.toolDuration,
    toolIntent: msg.toolIntent,
    toolDisplayName: msg.toolDisplayName,
    toolDisplayMeta: msg.toolDisplayMeta,  // Includes base64 icon for viewer
    parentToolUseId: msg.parentToolUseId,
    isError: msg.isError,
    attachments: msg.attachments,
    badges: msg.badges,  // Content badges for inline display (sources, skills, context)
    // Turn grouping
    isIntermediate: msg.isIntermediate,
    turnId: msg.turnId,
    // Error display
    errorCode: msg.errorCode,
    errorTitle: msg.errorTitle,
    errorDetails: msg.errorDetails,
    errorOriginal: msg.errorOriginal,
    errorCanRetry: msg.errorCanRetry,
    // Ultrathink
    ultrathink: msg.ultrathink,
    // Auth request fields
    authRequestId: msg.authRequestId,
    authRequestType: msg.authRequestType,
    authSourceSlug: msg.authSourceSlug,
    authSourceName: msg.authSourceName,
    authStatus: msg.authStatus,
    authCredentialMode: msg.authCredentialMode,
    authHeaderName: msg.authHeaderName,
    authLabels: msg.authLabels,
    authDescription: msg.authDescription,
    authHint: msg.authHint,
    authSourceUrl: msg.authSourceUrl,
    authError: msg.authError,
    authEmail: msg.authEmail,
    authWorkspace: msg.authWorkspace,
    // Queue state (for recovery after crash)
    isQueued: msg.isQueued,
  }
}

// Convert StoredMessage to runtime Message
function storedToMessage(stored: StoredMessage): Message {
  return {
    id: stored.id,
    role: stored.type,  // StoredMessage uses 'type', Message uses 'role'
    content: stored.content,
    timestamp: stored.timestamp ?? Date.now(),
    // Tool fields
    toolName: stored.toolName,
    toolUseId: stored.toolUseId,
    toolInput: stored.toolInput,
    toolResult: stored.toolResult,
    toolStatus: stored.toolStatus,
    toolDuration: stored.toolDuration,
    toolIntent: stored.toolIntent,
    toolDisplayName: stored.toolDisplayName,
    toolDisplayMeta: stored.toolDisplayMeta,  // Includes base64 icon for viewer
    parentToolUseId: stored.parentToolUseId,
    isError: stored.isError,
    attachments: stored.attachments,
    badges: stored.badges,  // Content badges for inline display (sources, skills, context)
    // Turn grouping
    isIntermediate: stored.isIntermediate,
    turnId: stored.turnId,
    // Error display
    errorCode: stored.errorCode,
    errorTitle: stored.errorTitle,
    errorDetails: stored.errorDetails,
    errorOriginal: stored.errorOriginal,
    errorCanRetry: stored.errorCanRetry,
    // Ultrathink
    ultrathink: stored.ultrathink,
    // Auth request fields
    authRequestId: stored.authRequestId,
    authRequestType: stored.authRequestType,
    authSourceSlug: stored.authSourceSlug,
    authSourceName: stored.authSourceName,
    authStatus: stored.authStatus,
    authCredentialMode: stored.authCredentialMode,
    authHeaderName: stored.authHeaderName,
    authLabels: stored.authLabels,
    authDescription: stored.authDescription,
    authHint: stored.authHint,
    authSourceUrl: stored.authSourceUrl,
    authError: stored.authError,
    authEmail: stored.authEmail,
    authWorkspace: stored.authWorkspace,
    // Queue state (for recovery after crash)
    isQueued: stored.isQueued,
  }
}

// Performance: Batch IPC delta events to reduce renderer load
const DELTA_BATCH_INTERVAL_MS = 50  // Flush batched deltas every 50ms

interface PendingDelta {
  delta: string
  turnId?: string
}

export class SessionManager {
  private sessions: Map<string, ManagedSession> = new Map()
  private windowManager: WindowManager | null = null
  // Delta batching for performance - reduces IPC events from 50+/sec to ~20/sec
  private pendingDeltas: Map<string, PendingDelta> = new Map()
  private deltaFlushTimers: Map<string, NodeJS.Timeout> = new Map()
  // Config watchers for live updates (sources, etc.) - one per workspace
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  // SDD compliance report watchers - one per session
  private complianceWatchers: Map<string, FSWatcher> = new Map()
  private complianceSyncTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  // Hook systems for workspace event hooks - one per workspace (includes scheduler, diffing, and handlers)
  private hookSystems: Map<string, HookSystem> = new Map()
  // Pending credential request resolvers (keyed by requestId)
  private pendingCredentialResolvers: Map<string, (response: import('../shared/types').CredentialResponse) => void> = new Map()
  // Promise deduplication for lazy-loading messages (prevents race conditions)
  private messageLoadingPromises: Map<string, Promise<void>> = new Map()
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId. Used to determine if a session should be
   * marked as unread when assistant completes - if user is viewing it, don't mark unread.
   */
  private activeViewingSession: Map<string, string> = new Map()
  /** Resolved path to @github/copilot CLI entry point (for CopilotAgent) */
  copilotCliPath: string | undefined
  /** Resolved path to Copilot network interceptor (for tool metadata capture) */
  copilotInterceptorPath: string | undefined
  /** Monotonic clock to ensure strictly increasing message timestamps */
  private lastTimestamp = 0

  // Quality gate runner (lazy-initialized) and cycle tracking
  private qualityGateRunner: QualityGateRunner | null = null
  private qualityGateCycles: Map<string, number> = new Map()

  // Teammate health monitor — detects stalls, error loops, retry storms
  private healthMonitor = new TeammateHealthMonitor()
  private healthMonitorTeams = new Set<string>() // teams with active monitoring
  private teamStatusIntervals = new Map<string, NodeJS.Timeout>() // periodic status checks
  private teamHealthAlertHandlers = new Map<string, (issue: HealthIssue) => void>()
  private teammateKickoffTimers = new Map<string, NodeJS.Timeout>()
  private usagePersistenceByWorkspace: Map<string, UsagePersistence> = new Map()
  private usageAlertCheckerByWorkspace: Map<string, UsageAlertChecker> = new Map()
  private emittedUsageAlertKeys: Set<string> = new Set()

  private getQualityGateRunner(): QualityGateRunner {
    if (!this.qualityGateRunner) {
      const credManager = getCredentialManager()
      this.qualityGateRunner = new QualityGateRunner({
        getMoonshotApiKey: () => credManager.getMoonshotApiKey(),
        getAnthropicApiKey: () => credManager.getLlmApiKey('anthropic-api'),
        getOpenAiConfig: async () => {
          const connections = getLlmConnections()
          for (const conn of connections) {
            if (conn.providerType !== 'openai' && conn.providerType !== 'openai_compat') continue
            if (conn.authType !== 'api_key' && conn.authType !== 'api_key_with_endpoint' && conn.authType !== 'bearer_token') {
              continue
            }
            const apiKey = await credManager.getLlmApiKey(conn.slug)
            if (apiKey) {
              return {
                apiKey,
                baseUrl: conn.baseUrl ?? null,
              }
            }
          }
          return null
        },
      })
    }
    return this.qualityGateRunner
  }

  /**
   * Start health monitoring for a team.
   * Registers event listeners for health issues and sets up periodic status check-ins.
   */
  private startTeamHealthMonitoring(teamId: string, leadSessionId: string): void {
    if (this.healthMonitorTeams.has(teamId)) return
    this.healthMonitorTeams.add(teamId)

    this.healthMonitor.startMonitoring(teamId)

    // Relay health alerts to the lead session + broadcast to dashboard
    const alertHandler = (issue: HealthIssue): void => {
      // Only relay alerts for teammates belonging to this team.
      const teammate = this.sessions.get(issue.teammateId)
      if (!teammate) return
      const teammateTeamId = teammate.teamId ? teamManager.resolveTeamId(teammate.teamId) : undefined
      if (teammateTeamId !== teamId) return
      const alertMessage = formatHealthAlertMessage(issue)
      setTimeout(async () => {
        try {
          await this.sendMessage(leadSessionId, alertMessage)
        } catch (err) {
          sessionLog.error('[AgentTeams] Failed to send health alert to lead:', err)
        }
      }, 100)

      // Broadcast health issue to the dashboard for inline card badges
      if (this.windowManager) {
        const envelope = {
          type: 'teammate:health_issue' as const,
          teamId,
          payload: {
            teammateId: issue.teammateId,
            teammateName: issue.teammateName,
            issueType: issue.type,
            details: issue.details,
            duration: issue.duration,
            taskId: issue.taskId,
          },
          timestamp: issue.detectedAt || new Date().toISOString(),
        }
        this.windowManager.broadcastToAll(IPC_CHANNELS.AGENT_TEAMS_EVENT, envelope)
      }
    }
    this.healthMonitor.on('health:stall', alertHandler)
    this.healthMonitor.on('health:error-loop', alertHandler)
    this.healthMonitor.on('health:retry-storm', alertHandler)
    this.healthMonitor.on('health:context-exhaustion', alertHandler)
    this.teamHealthAlertHandlers.set(teamId, alertHandler)

    // Periodic team status check-in (every 2 minutes)
    const statusInterval = setInterval(async () => {
      const health = this.healthMonitor.getTeamHealth(teamId)
      if (health.length === 0) return

      const lead = this.sessions.get(leadSessionId)
      if (!lead || !lead.isTeamLead) {
        // Lead gone — stop periodic checks
        clearInterval(statusInterval)
        this.teamStatusIntervals.delete(teamId)
        return
      }

      const liveHealth = health.filter(h => {
        const teammate = this.sessions.get(h.teammateId)
        if (!teammate || !teammate.parentSessionId) return false
        const teammateTeamId = teammate.teamId ? teamManager.resolveTeamId(teammate.teamId) : undefined
        return teammateTeamId === teamId
      })

      if (liveHealth.length === 0) {
        this.stopTeamHealthMonitoring(teamId)
        return
      }

      const lines = liveHealth.map(h => {
        const elapsed = Date.now() - new Date(h.lastActivityAt).getTime()
        const elapsedStr = elapsed < 60000 ? `${Math.round(elapsed / 1000)}s ago` : `${Math.round(elapsed / 60000)}m ago`
        const rawTask = h.currentTaskId ?? ''
        const taskLabel = rawTask.length > 60 ? rawTask.slice(0, 57) + '...' : rawTask
        const task = taskLabel ? `working on "${taskLabel}"` : 'idle'
        const issues = h.issues.length > 0 ? ` [${h.issues.length} issue(s)]` : ''
        return `- ${h.teammateName}: ${task} (last activity: ${elapsedStr})${issues}`
      })

      const statusMessage = `### Team Status Check-In\n${lines.join('\n')}`
      try {
        await this.sendMessage(leadSessionId, statusMessage)
      } catch (err) {
        sessionLog.error('[AgentTeams] Failed to send periodic team status:', err)
      }
    }, 2 * 60 * 1000)

    if (typeof statusInterval.unref === 'function') {
      statusInterval.unref()
    }
    this.teamStatusIntervals.set(teamId, statusInterval)
  }

  /**
   * Stop health monitoring for a team.
   */
  private stopTeamHealthMonitoring(teamId: string): void {
    this.healthMonitor.clearTeam(teamId)
    this.healthMonitorTeams.delete(teamId)

    const alertHandler = this.teamHealthAlertHandlers.get(teamId)
    if (alertHandler) {
      this.healthMonitor.off('health:stall', alertHandler)
      this.healthMonitor.off('health:error-loop', alertHandler)
      this.healthMonitor.off('health:retry-storm', alertHandler)
      this.healthMonitor.off('health:context-exhaustion', alertHandler)
      this.teamHealthAlertHandlers.delete(teamId)
    }

    const statusInterval = this.teamStatusIntervals.get(teamId)
    if (statusInterval) {
      clearInterval(statusInterval)
      this.teamStatusIntervals.delete(teamId)
    }
  }

  /**
   * Emit a teammate tool activity event to the dashboard via IPC.
   * Forwards a lightweight summary of tool calls so the Command Center
   * can show live worker activity without reading full session state.
   */
  private emitTeammateToolActivity(
    teamId: string,
    teammateId: string,
    teammateName: string,
    activity: {
      toolName: string
      toolDisplayName?: string
      toolIntent?: string
      toolUseId: string
      status: 'executing' | 'completed' | 'error'
      inputPreview?: string
      resultPreview?: string
      isError?: boolean
      elapsedMs?: number
    }
  ): void {
    if (!this.windowManager) return
    const envelope = {
      type: 'teammate:tool_activity' as const,
      teamId,
      payload: {
        teammateId,
        teammateName,
        ...activity,
      },
      timestamp: new Date().toISOString(),
    }
    this.windowManager.broadcastToAll(IPC_CHANNELS.AGENT_TEAMS_EVENT, envelope)
  }

  /**
   * Remove a teammate from lead tracking and health monitoring.
   * Safe to call repeatedly.
   */
  private detachTeammateTracking(teammate: ManagedSession): void {
    const parentSessionId = teammate.parentSessionId
    if (parentSessionId) {
      const lead = this.sessions.get(parentSessionId)
      if (lead?.teammateSessionIds?.length) {
        const next = lead.teammateSessionIds.filter(id => id !== teammate.id)
        lead.teammateSessionIds = next.length > 0 ? next : undefined
        this.persistSession(lead)
      }
    }

    const resolvedTeamId = teammate.teamId
      ? teamManager.resolveTeamId(teammate.teamId)
      : undefined
    if (resolvedTeamId) {
      this.healthMonitor.removeTeammate(resolvedTeamId, teammate.id)
      const hasLiveTeammates = Array.from(this.sessions.values()).some(s => {
        if (s.id === teammate.id) return false
        if (!s.parentSessionId || !s.teamId) return false
        return teamManager.resolveTeamId(s.teamId) === resolvedTeamId
      })
      if (!hasLiveTeammates) {
        this.stopTeamHealthMonitoring(resolvedTeamId)
      }
    }
  }

  /**
   * Deterministically terminate a teammate session runtime and detach all team tracking.
   */
  private async terminateTeammateSession(teammateId: string, reason: string): Promise<boolean> {
    const teammate = this.sessions.get(teammateId)
    if (!teammate) return false

    const kickoffTimer = this.teammateKickoffTimers.get(teammateId)
    if (kickoffTimer) {
      clearTimeout(kickoffTimer)
      this.teammateKickoffTimers.delete(teammateId)
    }

    if (teammate.agent && teammate.isProcessing) {
      try {
        teammate.agent.forceAbort(AbortReason.UserStop)
      } catch (err) {
        sessionLog.warn(`[AgentTeams] Failed to force-abort teammate ${teammateId} during ${reason}:`, err)
      }
    }

    this.destroyManagedAgent(teammate, reason)
    this.stopComplianceWatcher(teammateId)
    this.detachTeammateTracking(teammate)

    teammate.teamId = undefined
    teammate.parentSessionId = undefined
    teammate.teammateName = undefined
    teammate.isProcessing = false
    this.persistSession(teammate)
    return true
  }

  private formatLeadToTeammateMessage(content: string): string {
    return `## Team Lead Message\n\n${content.trim()}`
  }

  private formatQualityGateSummary(result: QualityGateResult): string {
    const stageOrder: Array<keyof QualityGateResult['stages']> = [
      'syntax',
      'tests',
      'architecture',
      'simplicity',
      'errors',
      'completeness',
    ]

    const labelFor = (stage: keyof QualityGateResult['stages']): string => {
      if (stage === 'syntax') return 'Syntax'
      if (stage === 'tests') return 'Tests'
      if (stage === 'architecture') return 'Architecture'
      if (stage === 'simplicity') return 'Simplicity'
      if (stage === 'errors') return 'Error Handling'
      if (stage === 'completeness') return 'Completeness'
      return String(stage)
    }

    const stageLines = stageOrder
      .map(stage => {
        const stageResult = result.stages[stage]
        if (!stageResult) return null
        const status = stageResult.passed ? '✅' : '❌'
        return `- ${status} **${labelFor(stage)}:** ${Math.round(stageResult.score)}%`
      })
      .filter((line): line is string => Boolean(line))

    return [
      `### Quality Gate`,
      ``,
      `**Overall:** ${result.passed ? '✅ PASS' : '❌ FAIL'} · **Score:** ${Math.round(result.aggregateScore)}% · **Cycle:** ${result.cycleCount ?? 1}/${result.maxCycles ?? 1}`,
      ``,
      ...stageLines,
    ].join('\n')
  }

  /**
   * Create and attach a YOLO orchestrator for a team.
   * Called when YOLO mode is enabled in workspace config and a team is active.
   */
  private setupYoloOrchestrator(teamId: string, leadSessionId: string, workingDirectory: string): YoloOrchestrator | null {
    const lead = this.sessions.get(leadSessionId)
    if (!lead) return null

    const wsConfig = loadWorkspaceConfig(lead.workspace.rootPath)
    const yoloConfig = mergeYoloConfig(wsConfig?.agentTeams?.yolo)
    if (yoloConfig.mode === 'off') return null

    const reviewLoop = teamManager.getReviewLoop()
    if (!reviewLoop) {
      sessionLog.warn('[YOLO] Cannot start YOLO — no review loop attached')
      return null
    }

    const callbacks: YoloCallbacks = {
      generateSpec: async (_teamId: string, objective: string) => {
        // Instruct the lead to generate a spec by sending a structured message
        await this.sendMessage(leadSessionId,
          `[YOLO] Generate a specification for the following objective. Output a structured spec with requirements, risks, and acceptance tests.\n\nObjective: ${objective}`)
        // Poll for the spec — the lead processes the message asynchronously
        const MAX_SPEC_WAIT_MS = 5 * 60 * 1000 // 5 minutes
        const SPEC_POLL_MS = 2000
        const specStart = Date.now()
        while (Date.now() - specStart < MAX_SPEC_WAIT_MS) {
          const spec = teamManager.getTeamSpec(_teamId)
          if (spec) return spec
          await new Promise(resolve => setTimeout(resolve, SPEC_POLL_MS))
        }
        throw new Error('Lead did not generate a spec within the timeout')
      },

      decomposeIntoTasks: async (_teamId: string, spec) => {
        return spec.requirements.map((req, idx) => ({
          title: `Implement ${req.id}: ${req.description.slice(0, 60)}`,
          description: req.description,
          requirementIds: [req.id],
          phase: req.priority === 'critical' ? 'foundation' : req.priority === 'high' ? 'core' : 'polish',
          phaseOrder: req.priority === 'critical' ? 0 : req.priority === 'high' ? 1 : 2,
        }))
      },

      spawnAndAssign: async (_teamId: string, taskIds: string[]) => {
        const tasks = teamManager.getTasks(_teamId)
        // Resolve the worker model from presets instead of using the lead's model
        const workerAssignment = resolveTeamModelForRole(wsConfig, 'worker', undefined, lead.model)
        const workerModel = workerAssignment.model !== 'unknown' ? workerAssignment.model : lead.model
        for (const taskId of taskIds) {
          const task = tasks.find(t => t.id === taskId)
          if (!task) continue
          try {
            const teammateSession = await this.createTeammateSession({
              parentSessionId: leadSessionId,
              workspaceId: lead.workspace.id,
              teamId: _teamId,
              teammateName: `worker-${taskId.slice(-6)}`,
              prompt: task.description || task.title,
              model: workerModel,
            })
            // Assign the task to the spawned teammate
            const team = teamManager.getTeam(_teamId)
            const teammate = team?.members.find(m => m.sessionId === teammateSession.id)
            if (teammate) {
              teamManager.assignTask(_teamId, taskId, teammate.id)
            }
          } catch (err) {
            sessionLog.error(`[YOLO] Failed to spawn teammate for task ${taskId}:`, err)
          }
        }
      },

      runIntegrationCheck: async (_teamId: string) => {
        try {
          const runner = this.getQualityGateRunner()
          const syntaxResult = await runner.runSyntaxCheck(workingDirectory)
          const testResult = await runner.runTestExecution(workingDirectory)
          const issues: string[] = [
            ...syntaxResult.issues,
            ...testResult.issues,
          ]
          return {
            passed: syntaxResult.passed && testResult.passed,
            issues,
          }
        } catch (err) {
          return {
            passed: false,
            issues: [err instanceof Error ? err.message : String(err)],
          }
        }
      },

      synthesize: async (_teamId: string) => {
        const tasks = teamManager.getTasks(_teamId)
        const completed = tasks.filter(t => t.status === 'completed').length
        return `YOLO run complete: ${completed}/${tasks.length} tasks completed`
      },

      onStateChange: (_teamId: string, state: YoloState) => {
        teamManager.updateYoloState(_teamId, state)
        this.sendEvent({
          type: 'yolo_state_changed',
          sessionId: leadSessionId,
          teamId: _teamId,
          state,
        }, lead.workspace.id)
        // Also broadcast as a team event for the dashboard hook
        if (this.windowManager) {
          const phases = teamManager.getTeamPhases(_teamId)
          const envelope: import('@craft-agent/core/types').YoloStateChangedEvent = {
            type: 'yolo:state_changed',
            teamId: _teamId,
            payload: { state, phases: phases.length > 0 ? phases : undefined },
            timestamp: new Date().toISOString(),
          }
          this.windowManager.broadcastToAll(IPC_CHANNELS.AGENT_TEAMS_EVENT, envelope)
        }
      },
    }

    const orchestrator = new YoloOrchestrator(teamManager, reviewLoop, callbacks)
    teamManager.setYoloOrchestrator(teamId, orchestrator)

    sessionLog.info(`[YOLO] Orchestrator created for team ${teamId} (mode: ${yoloConfig.mode})`)
    return orchestrator
  }

  private deriveYoloObjectiveFromLead(managed: ManagedSession, fallbackTeamName?: string): string {
    for (let i = managed.messages.length - 1; i >= 0; i--) {
      const msg = managed.messages[i]
      if (msg?.role !== 'user') continue
      const content = typeof msg.content === 'string' ? msg.content.trim() : ''
      if (content.length > 0) return content
    }
    return managed.name?.trim() || `Execute the team objective for ${fallbackTeamName || managed.id}`
  }

  /**
   * Ensure a YOLO orchestrator exists for a team if workspace config enables it.
   * This wires callbacks/state flow but does not force-start a run.
   */
  ensureYoloWiredForTeam(teamId: string, leadSessionId: string): void {
    const lead = this.sessions.get(leadSessionId)
    if (!lead) return

    const resolvedTeamId = teamManager.resolveTeamId(teamId)
    if (!teamManager.getTeam(resolvedTeamId)) return

    if (teamManager.getYoloOrchestrator(resolvedTeamId)) return

    const wsConfig = loadWorkspaceConfig(lead.workspace.rootPath)
    const yoloConfig = mergeYoloConfig(wsConfig?.agentTeams?.yolo)
    if (yoloConfig.mode === 'off') return

    const workingDirectory = lead.workingDirectory || lead.sdkCwd || getSessionStoragePath(lead.workspace.rootPath, lead.id)
    this.setupYoloOrchestrator(resolvedTeamId, leadSessionId, workingDirectory)
  }

  /**
   * Best-effort auto-start for YOLO runs when a team becomes active.
   */
  private startYoloIfConfigured(managed: ManagedSession, teamId: string): void {
    const resolvedTeamId = teamManager.resolveTeamId(teamId)
    const team = teamManager.getTeam(resolvedTeamId)
    if (!team) {
      sessionLog.warn(`[YOLO] Team ${teamId} not found, skipping auto-start`)
      return
    }

    this.ensureYoloWiredForTeam(resolvedTeamId, managed.id)
    const orchestrator = teamManager.getYoloOrchestrator(resolvedTeamId)
    if (!orchestrator || orchestrator.isRunning()) return

    const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const yoloConfig = mergeYoloConfig(wsConfig?.agentTeams?.yolo)
    if (yoloConfig.mode === 'off') return

    const objective = this.deriveYoloObjectiveFromLead(managed, team.name)
    sessionLog.info(`[YOLO] Auto-starting run for team ${resolvedTeamId} objective="${objective.slice(0, 80)}"`)
    void orchestrator.start(resolvedTeamId, objective, yoloConfig).catch((error) => {
      sessionLog.error(`[YOLO] Auto-start failed for team ${resolvedTeamId}:`, error)
    })
  }

  setWindowManager(wm: WindowManager): void {
    this.windowManager = wm
  }

  getWorkspaceIdForSession(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.workspace.id ?? null
  }

  getUsageThresholds(workspaceId: string): UsageAlertThresholds {
    return this.getUsageAlertChecker(workspaceId).getThresholds()
  }

  setUsageThresholds(workspaceId: string, thresholds: Partial<UsageAlertThresholds>): UsageAlertThresholds {
    const checker = this.getUsageAlertChecker(workspaceId)
    checker.updateThresholds(thresholds)
    return checker.getThresholds()
  }

  private getUsagePersistence(workspaceId: string): UsagePersistence {
    let persistence = this.usagePersistenceByWorkspace.get(workspaceId)
    if (!persistence) {
      persistence = new UsagePersistence(workspaceId)
      this.usagePersistenceByWorkspace.set(workspaceId, persistence)
    }
    return persistence
  }

  private getUsageAlertChecker(workspaceId: string): UsageAlertChecker {
    let checker = this.usageAlertCheckerByWorkspace.get(workspaceId)
    if (!checker) {
      checker = new UsageAlertChecker()
      this.usageAlertCheckerByWorkspace.set(workspaceId, checker)
    }
    return checker
  }

  private resolvePrimaryUsageProvider(managed: ManagedSession): UsageProviderKey {
    if (managed.llmProvider) return managed.llmProvider
    const connection = managed.llmConnection ? getLlmConnection(managed.llmConnection) : null
    if (connection?.providerType === 'openai') {
      return 'openai'
    }
    if (connection?.providerType === 'openai_compat') {
      return inferProviderFromModel(managed.model || connection.defaultModel)
    }
    if (connection) return 'anthropic'
    return inferProviderFromModel(managed.model)
  }

  private mapTeammateProvider(provider?: string): UsageProviderKey {
    if (provider === 'openai') return 'openai'
    if (provider === 'moonshot') return 'moonshot'
    if (provider === 'openrouter') return 'openrouter'
    if (provider === 'anthropic') return 'anthropic'
    return 'anthropic'
  }

  private buildSessionUsageSnapshot(managed: ManagedSession): PersistedSessionUsage {
    const now = new Date()
    const persistence = this.getUsagePersistence(managed.workspace.id)
    const weekIdentifier = persistence.getWeekIdentifier(now)
    const startedAtMs = managed.createdAt ?? managed.lastMessageAt ?? now.getTime()
    const base = managed.usageSummary
      ? JSON.parse(JSON.stringify(managed.usageSummary)) as PersistedSessionUsage
      : createEmptySessionUsage(managed.id, startedAtMs)

    base.weekIdentifier = weekIdentifier
    base.lastUpdatedAt = now.toISOString()
    base.totalDurationMs = Math.max(0, now.getTime() - startedAtMs)

    // Backfill legacy sessions from tokenUsage if no turn-level usage has been captured yet.
    const hasProviderCalls = Object.values(base.providers).some(p => p.callCount > 0)
    if (!hasProviderCalls && managed.tokenUsage) {
      const provider = this.resolvePrimaryUsageProvider(managed)
      const inputTokens = managed.tokenUsage.inputTokens ?? 0
      const outputTokens = managed.tokenUsage.outputTokens ?? 0
      const costUsd = managed.tokenUsage.costUsd ?? calculateTokenCostUsd({
        model: managed.model,
        provider,
        inputTokens,
        outputTokens,
        cachedInputTokens: managed.tokenUsage.cacheReadTokens,
      })
      base.providers[provider].inputTokens += inputTokens
      base.providers[provider].outputTokens += outputTokens
      base.providers[provider].estimatedCostUsd += costUsd
      if (inputTokens > 0 || outputTokens > 0 || costUsd > 0) {
        base.providers[provider].callCount += 1
      }
      base.totalCalls = Object.values(base.providers).reduce((sum, p) => sum + p.callCount, 0)
    }

    if (managed.isTeamLead && managed.teammateSessionIds?.length) {
      this.updateLeadTeamUsageFromTeammate(managed)
      if (managed.usageSummary?.teamUsage) {
        base.teamUsage = JSON.parse(JSON.stringify(managed.usageSummary.teamUsage)) as PersistedSessionUsage['teamUsage']
      }
    } else if (managed.teamId && !base.teamUsage) {
      // Fallback to in-memory team manager state if available
      const team = teamManager.getTeam(teamManager.resolveTeamId(managed.teamId))
      if (team) {
        const perTeammate: NonNullable<PersistedSessionUsage['teamUsage']>['perTeammate'] = {}
        const perModel: NonNullable<PersistedSessionUsage['teamUsage']>['perModel'] = {}
        let totalTeamCostUsd = 0

        for (const member of team.members) {
          const usage = member.tokenUsage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
          const providerKey = this.mapTeammateProvider(member.provider)
          base.providers[providerKey].inputTokens += usage.inputTokens
          base.providers[providerKey].outputTokens += usage.outputTokens
          base.providers[providerKey].estimatedCostUsd += usage.costUsd
          totalTeamCostUsd += usage.costUsd

          perTeammate[member.id] = {
            name: member.name,
            model: member.model,
            provider: member.provider,
            role: member.role,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: usage.costUsd,
            callCount: 0,
          }

          if (!perModel[member.model]) {
            perModel[member.model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, callCount: 0 }
          }
          perModel[member.model].inputTokens += usage.inputTokens
          perModel[member.model].outputTokens += usage.outputTokens
          perModel[member.model].costUsd += usage.costUsd
        }

        base.teamUsage = {
          teamId: team.id,
          teammateCount: team.members.length,
          totalTeamCostUsd,
          perTeammate,
          perModel,
        }
      }
    }

    return base
  }

  private async rebuildWeeklyUsageFromSnapshots(workspaceId: string, weekIdentifier: string): Promise<void> {
    const persistence = this.getUsagePersistence(workspaceId)
    const weeklyPath = join(
      homedir(),
      '.craft-agent',
      'workspaces',
      workspaceId,
      'usage',
      `weekly-${weekIdentifier}.json`
    )

    // Rebuild from scratch to avoid duplicate session entries when saving periodic snapshots.
    await rm(weeklyPath, { force: true }).catch(() => undefined)

    const workspaceSessions = Array.from(this.sessions.values()).filter(s => s.workspace.id === workspaceId)
    for (const session of workspaceSessions) {
      const usage = await persistence.loadSessionUsage(session.id)
      if (usage && usage.weekIdentifier === weekIdentifier) {
        await persistence.recordSessionEnd(session.id, usage)
      }
    }
  }

  private emitUsageCostUpdate(workspaceId: string, usage: PersistedSessionUsage): void {
    if (!this.windowManager) return

    for (const window of this.windowManager.getAllWindowsForWorkspace(workspaceId)) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
        window.webContents.send(IPC_CHANNELS.USAGE_COST_UPDATE, usage)
      }
    }
  }

  private emitUsageAlert(workspaceId: string, alert: UsageAlert): void {
    if (!this.windowManager) return

    const alertKey = `${workspaceId}:${alert.type}:${alert.message}`
    if (this.emittedUsageAlertKeys.has(alertKey)) {
      return
    }
    this.emittedUsageAlertKeys.add(alertKey)

    for (const window of this.windowManager.getAllWindowsForWorkspace(workspaceId)) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed() && window.webContents.mainFrame) {
        window.webContents.send(IPC_CHANNELS.USAGE_ALERT, alert)
      }
    }
  }

  private async persistAndBroadcastUsage(managed: ManagedSession): Promise<void> {
    try {
      const persistence = this.getUsagePersistence(managed.workspace.id)
      const usage = this.buildSessionUsageSnapshot(managed)
      await persistence.saveSessionUsage(managed.id, usage)
      await this.rebuildWeeklyUsageFromSnapshots(managed.workspace.id, usage.weekIdentifier)

      this.emitUsageCostUpdate(managed.workspace.id, usage)

      const weekly = await persistence.getCurrentWeekUsage()
      const checker = this.getUsageAlertChecker(managed.workspace.id)
      const alerts = checker.checkAlerts(usage, weekly)
      for (const alert of alerts) {
        this.emitUsageAlert(managed.workspace.id, alert)
      }
    } catch (error) {
      sessionLog.error(`Failed to persist usage snapshot for session ${managed.id}:`, error)
    }
  }
  /** Returns a strictly increasing timestamp (ms). When Date.now() collides with
   *  the previous value, increments by 1 to preserve event ordering. */
  private monotonic(): number {
    const now = Date.now()
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  /**
   * Set up ConfigWatcher for a workspace to broadcast live updates
   * (sources added/removed, guide.md changes, etc.)
   * Called during window init (GET_WINDOW_WORKSPACE) and workspace switch.
   * workspaceId must be the global config ID (what the renderer knows).
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    // Check if already watching this workspace
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    sessionLog.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        sessionLog.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        // Broadcast to UI
        this.broadcastSourcesChanged(sources)
        // Reload sources for all sessions in this workspace
        // Skip sessions that are currently processing to avoid interrupting tool calls
        for (const [_, managed] of this.sessions) {
          if (managed.workspace.rootPath === workspaceRootPath) {
            if (managed.isProcessing) {
              sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
              continue
            }
            await this.reloadSessionSources(managed)
          }
        }
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        sessionLog.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(sources)
        // Reload sources for all sessions in this workspace
        // Skip sessions that are currently processing to avoid interrupting tool calls
        for (const [_, managed] of this.sessions) {
          if (managed.workspace.rootPath === workspaceRootPath) {
            if (managed.isProcessing) {
              sessionLog.info(`Skipping source reload for session ${managed.id} (processing)`)
              continue
            }
            await this.reloadSessionSources(managed)
          }
        }
      },
      onSourceGuideChange: (sourceSlug: string) => {
        sessionLog.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(sources)
      },
      onStatusConfigChange: () => {
        sessionLog.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        sessionLog.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        sessionLog.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange hook via HookSystem
        const hookSystem = this.hookSystems.get(workspaceRootPath)
        if (hookSystem) {
          hookSystem.emitLabelConfigChange().catch((error) => {
            sessionLog.error(`[Hooks] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onHooksConfigChange: () => {
        sessionLog.info(`Hooks config changed in ${workspaceId}`)
        // Reload hooks config via HookSystem
        const hookSystem = this.hookSystems.get(workspaceRootPath)
        if (hookSystem) {
          const result = hookSystem.reloadConfig()
          if (result.errors.length === 0) {
            sessionLog.info(`Reloaded ${result.hookCount} hooks for workspace ${workspaceId}`)
          } else {
            sessionLog.error(`Failed to reload hooks for workspace ${workspaceId}:`, result.errors)
          }
        }
      },
      onAppThemeChange: (theme) => {
        sessionLog.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        sessionLog.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        sessionLog.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(skills)
      },
      onSkillChange: async (slug, skill) => {
        sessionLog.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadWorkspaceSkills } = await import('@craft-agent/shared/skills')
        const skills = loadWorkspaceSkills(workspaceRootPath)
        this.broadcastSkillsChanged(skills)
      },

      // Session metadata changes (external edits to session.jsonl headers).
      // Detects label/flag/name/todoState changes made by other instances or scripts.
      // Compares with in-memory state and only emits events for actual differences.
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return

        // Skip if session is currently processing — in-memory state is authoritative during streaming
        if (managed.isProcessing) return

        let changed = false

        // Labels
        const oldLabels = JSON.stringify(managed.labels ?? [])
        const newLabels = JSON.stringify(header.labels ?? [])
        if (oldLabels !== newLabels) {
          managed.labels = header.labels
          this.sendEvent({ type: 'labels_changed', sessionId, labels: header.labels ?? [] }, managed.workspace.id)
          changed = true
        }

        // Flagged
        if ((managed.isFlagged ?? false) !== (header.isFlagged ?? false)) {
          managed.isFlagged = header.isFlagged ?? false
          this.sendEvent(
            { type: header.isFlagged ? 'session_flagged' : 'session_unflagged', sessionId },
            managed.workspace.id
          )
          changed = true
        }

        // Todo state
        if (managed.todoState !== header.todoState) {
          managed.todoState = header.todoState
          this.sendEvent({ type: 'todo_state_changed', sessionId, todoState: header.todoState ?? '' }, managed.workspace.id)
          changed = true
        }

        // Name
        if (managed.name !== header.name) {
          managed.name = header.name
          this.sendEvent({ type: 'name_changed', sessionId, name: header.name }, managed.workspace.id)
          changed = true
        }

        if (changed) {
          sessionLog.info(`External metadata change detected for session ${sessionId}`)
        }

        // Update session metadata via HookSystem (handles diffing and event emission internally)
        const hookSystem = this.hookSystems.get(workspaceRootPath)
        if (hookSystem) {
          hookSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: header.labels,
            isFlagged: header.isFlagged,
            todoState: header.todoState,
            sessionName: header.name,
          }).catch((error) => {
            sessionLog.error(`[Hooks] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize HookSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.hookSystems.has(workspaceRootPath)) {
      const hookSystem = new HookSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: async (prompts) => {
          // Execute prompt hooks by creating new sessions
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptHook(
                workspaceId,
                workspaceRootPath,
                pending.prompt,
                pending.labels,
                pending.permissionMode,
                pending.mentions,
              )
            )
          )
          for (const [idx, result] of settled.entries()) {
            if (result.status === 'rejected') {
              sessionLog.error(`[Hooks] Failed to execute prompt hook ${idx + 1}:`, result.reason)
            } else {
              sessionLog.info(`[Hooks] Created session ${result.value.sessionId} from prompt hook`)
            }
          }
        },
        onError: (event, error) => {
          sessionLog.error(`Hook failed for ${event}:`, error.message)
        },
      })
      this.hookSystems.set(workspaceRootPath, hookSystem)
      sessionLog.info(`Initialized HookSystem for workspace ${workspaceId}`)
    }
  }

  /**
   * Broadcast sources changed event to all windows
   */
  private broadcastSourcesChanged(sources: LoadedSource[]): void {
    if (!this.windowManager) return

    this.windowManager.broadcastToAll(IPC_CHANNELS.SOURCES_CHANGED, sources)
  }

  /**
   * Broadcast statuses changed event to all windows
   */
  private broadcastStatusesChanged(workspaceId: string): void {
    if (!this.windowManager) return
    sessionLog.info(`Broadcasting statuses changed for ${workspaceId}`)
    this.windowManager.broadcastToAll(IPC_CHANNELS.STATUSES_CHANGED, workspaceId)
  }

  /**
   * Broadcast labels changed event to all windows
   */
  private broadcastLabelsChanged(workspaceId: string): void {
    if (!this.windowManager) return
    sessionLog.info(`Broadcasting labels changed for ${workspaceId}`)
    this.windowManager.broadcastToAll(IPC_CHANNELS.LABELS_CHANGED, workspaceId)
  }

  /**
   * Broadcast app theme changed event to all windows
   */
  private broadcastAppThemeChanged(theme: import('@craft-agent/shared/config').ThemeOverrides | null): void {
    if (!this.windowManager) return
    sessionLog.info(`Broadcasting app theme changed`)
    this.windowManager.broadcastToAll(IPC_CHANNELS.THEME_APP_CHANGED, theme)
  }

  /**
   * Broadcast skills changed event to all windows
   */
  private broadcastSkillsChanged(skills: import('@craft-agent/shared/skills').LoadedSkill[]): void {
    if (!this.windowManager) return
    sessionLog.info(`Broadcasting skills changed (${skills.length} skills)`)
    this.windowManager.broadcastToAll(IPC_CHANNELS.SKILLS_CHANGED, skills)
  }

  /**
   * Broadcast default permissions changed event to all windows
   * Triggered when ~/.craft-agent/permissions/default.json changes
   */
  private broadcastDefaultPermissionsChanged(): void {
    if (!this.windowManager) return
    sessionLog.info('Broadcasting default permissions changed')
    this.windowManager.broadcastToAll(IPC_CHANNELS.DEFAULT_PERMISSIONS_CHANGED, null)
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  private async reloadSessionSources(managed: ManagedSession): Promise<void> {
    if (!managed.agent) return  // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    // For Codex backend, regenerate config.toml and reconnect
    if (managed.agent instanceof CodexBackend) {
      await setupCodexSessionConfig(sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath)
      // Reconnect to pick up the new config
      await managed.agent.reconnect()
      sessionLog.info(`Codex config regenerated and reconnected for session ${managed.id}`)
    }

    // For Copilot backend, write bridge config for API sources
    if (managed.agent instanceof CopilotAgent) {
      const copilotConfigDir = join(sessionPath, '.copilot-config')
      await setupCopilotBridgeConfig(copilotConfigDir, enabledSources)
    }

    managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sessionLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * Reinitialize authentication environment variables.
   * Call this after onboarding or settings changes to pick up new credentials.
   *
   * SECURITY NOTE: These env vars are propagated to the SDK subprocess via options.ts.
   * Bun's automatic .env loading is disabled in the subprocess (--env-file=/dev/null)
   * to prevent a user's project .env from injecting ANTHROPIC_API_KEY and overriding
   * OAuth auth — Claude Code prioritizes API key over OAuth token when both are set.
   * See: https://github.com/lukilabs/craft-agents-oss/issues/39
   */
  /**
   * Reinitialize authentication environment variables.
   *
   * Uses the default LLM connection to determine which credentials to set.
   *
   * @param connectionSlug - Optional connection slug to use (overrides default)
   */
  async reinitializeAuth(connectionSlug?: string): Promise<void> {
    try {
      const manager = getCredentialManager()

      // Get the connection to use (explicit parameter or default)
      const slug = connectionSlug || getDefaultLlmConnection()
      if (!slug) {
        sessionLog.warn('No LLM connection slug available for reinitializeAuth')
      }
      const connection = slug ? getLlmConnection(slug) : null

      // Clear all auth env vars first to ensure clean state
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      delete process.env.ANTHROPIC_BASE_URL

      if (!connection) {
        sessionLog.error(`No LLM connection found for slug: ${slug}`)
        resetSummarizationClient()
        return
      } else {
        sessionLog.info(`Reinitializing auth for connection: ${slug} (${connection.authType})`)

        // Set base URL if configured on connection
        if (connection.baseUrl) {
          process.env.ANTHROPIC_BASE_URL = connection.baseUrl
        }

        // Set credentials based on connection auth type
        // Note: slug is guaranteed non-null here since connection was found
        if (connection.authType === 'api_key' || connection.authType === 'api_key_with_endpoint' || connection.authType === 'bearer_token') {
          const apiKey = await manager.getLlmApiKey(slug!)
          if (apiKey) {
            process.env.ANTHROPIC_API_KEY = apiKey
            sessionLog.info(`Set API key for connection: ${slug}`)
          } else if (connection.baseUrl) {
            // Keyless provider (e.g., local endpoint) - SDK still expects a token-shaped value.
            process.env.ANTHROPIC_API_KEY = 'not-needed'
            sessionLog.info(`Using keyless connection mode for provider: ${slug}`)
          } else {
            sessionLog.error(`No API key found for connection: ${slug}`)
          }
        } else if (connection.authType === 'oauth') {
          // For Anthropic OAuth, use getValidClaudeOAuthToken which handles refresh
          if (connection.providerType === 'anthropic') {
            const tokenResult = await getValidClaudeOAuthToken(slug!)
            if (tokenResult.accessToken) {
              process.env.CLAUDE_CODE_OAUTH_TOKEN = tokenResult.accessToken
              sessionLog.info(`Set refreshed OAuth token for connection: ${slug}`)
            } else {
              sessionLog.error(`Failed to get valid OAuth token for connection: ${slug}`)
            }
          } else {
            // Other OAuth providers (fallback to direct read)
            const llmOAuth = await manager.getLlmOAuth(slug!)
            if (llmOAuth?.accessToken) {
              process.env.CLAUDE_CODE_OAUTH_TOKEN = llmOAuth.accessToken
              sessionLog.info(`Set OAuth token for connection: ${slug}`)
            } else {
              sessionLog.error(`No OAuth token found for connection: ${slug}`)
            }
          }
        }
        // OpenAI OAuth doesn't use env vars - handled by CodexAgent via tryInjectStoredChatGptTokens
      }

      // Reset cached summarization client so it picks up new credentials/base URL
      resetSummarizationClient()
    } catch (error) {
      sessionLog.error('Failed to reinitialize auth:', error)
      throw error
    }
  }

  async initialize(): Promise<void> {
    // Set path to Claude Code executable (cli.js from SDK)
    // In packaged app: use app.getAppPath() (points to app folder, ASAR is disabled)
    // In development: use process.cwd()
    const basePath = app.isPackaged ? app.getAppPath() : process.cwd()

    // In monorepos, dependencies may be hoisted to the root node_modules
    // Try local first, then check monorepo root (two levels up from apps/electron)
    const sdkRelativePath = join('node_modules', '@anthropic-ai', 'claude-agent-sdk', 'cli.js')
    let cliPath = join(basePath, sdkRelativePath)
    if (!existsSync(cliPath) && !app.isPackaged) {
      // Try monorepo root (../../node_modules from apps/electron)
      const monorepoRoot = join(basePath, '..', '..')
      cliPath = join(monorepoRoot, sdkRelativePath)
    }
    if (!existsSync(cliPath)) {
      const error = `Claude Code SDK not found at ${cliPath}. The app package may be corrupted.`
      sessionLog.error(error)
      throw new Error(error)
    }
    sessionLog.info('Setting pathToClaudeCodeExecutable:', cliPath)
    setPathToClaudeCodeExecutable(cliPath)

    // Resolve path to @github/copilot CLI (for CopilotAgent)
    // The SDK's getBundledCliPath() uses import.meta.resolve() which breaks in esbuild bundles
    const copilotRelativePath = join('node_modules', '@github', 'copilot', 'index.js')
    let copilotPath = join(basePath, copilotRelativePath)
    if (!existsSync(copilotPath) && !app.isPackaged) {
      const monorepoRoot = join(basePath, '..', '..')
      copilotPath = join(monorepoRoot, copilotRelativePath)
    }
    if (existsSync(copilotPath)) {
      this.copilotCliPath = copilotPath
      sessionLog.info('Resolved Copilot CLI path:', copilotPath)
    } else {
      sessionLog.warn('Copilot CLI not found — Copilot sessions will try SDK default resolution')
    }

    // Set path to fetch interceptor for SDK subprocess
    // This interceptor captures API errors and adds metadata to MCP tool schemas
    // In monorepos, packages may be at the root level, not inside apps/electron
    const interceptorRelativePath = join('packages', 'shared', 'src', 'network-interceptor.ts')
    let interceptorPath = join(basePath, interceptorRelativePath)
    if (!existsSync(interceptorPath) && !app.isPackaged) {
      // Try monorepo root (../../packages from apps/electron)
      const monorepoRoot = join(basePath, '..', '..')
      interceptorPath = join(monorepoRoot, interceptorRelativePath)
    }
    if (!existsSync(interceptorPath)) {
      const error = `Network interceptor not found at ${interceptorPath}. The app package may be corrupted.`
      sessionLog.error(error)
      throw new Error(error)
    }
    // Set interceptor path (used for --preload flag with bun)
    sessionLog.info('Setting interceptorPath:', interceptorPath)
    setInterceptorPath(interceptorPath)

    // Use bundled Bun binary (packaged app) or system bun.exe (dev mode)
    // Resolve Copilot network interceptor (loaded via NODE_OPTIONS="--require ..." into Copilot CLI subprocess)
    // Must be bundled CJS since it runs under Electron's Node.js, not Bun
    // Built by `bun run build:copilot-interceptor` → apps/electron/dist/copilot-interceptor.cjs
    // In dev: basePath is monorepo root, so add apps/electron/ prefix
    // In packaged: basePath is the app dir, dist/ is directly inside
    let copilotInterceptorPath = join(basePath, 'dist', 'copilot-interceptor.cjs')
    if (!existsSync(copilotInterceptorPath) && !app.isPackaged) {
      copilotInterceptorPath = join(basePath, 'apps', 'electron', 'dist', 'copilot-interceptor.cjs')
    }
    if (existsSync(copilotInterceptorPath)) {
      this.copilotInterceptorPath = copilotInterceptorPath
      sessionLog.info('Resolved Copilot interceptor path:', copilotInterceptorPath)
    } else {
      sessionLog.warn('Copilot network interceptor not found — run `bun run build:copilot-interceptor` in apps/electron/')
    }

    // In packaged app: use bundled Bun binary
    // In development: use system 'bun' command (no need to set executable)
    const bundledBunPath = getBundledBunPath()
    if (app.isPackaged && !bundledBunPath) {
      const error = 'Bundled Bun runtime not found. The app package may be corrupted.'
      sessionLog.error(error)
      throw new Error(error)
    }
    if (bundledBunPath) {
      sessionLog.info('Setting executable:', bundledBunPath)
      setExecutable(bundledBunPath)
    }

    // Backfill missing `models` arrays on existing LLM connections
    migrateLegacyLlmConnectionsConfig()

    // Fix defaultLlmConnection if it points to a non-existent connection
    migrateOrphanedDefaultConnections()

    // Migrate legacy credentials to LLM connection format (one-time migration)
    // This ensures credentials saved before LLM connections are available via the new system
    await migrateLegacyCredentials()

    // Set up authentication environment variables (critical for SDK to work)
    await this.reinitializeAuth()

    // Load existing sessions from disk
    this.loadSessionsFromDisk()
  }

  // Load all existing sessions from disk into memory (metadata only - messages are lazy-loaded)
  private loadSessionsFromDisk(): void {
    try {
      const workspaces = getWorkspaces()
      let totalSessions = 0

      // Iterate over each workspace and load its sessions
      for (const workspace of workspaces) {
        const workspaceRootPath = workspace.rootPath
        const sessionMetadata = listStoredSessions(workspaceRootPath)
        // Load workspace config once per workspace for default working directory
        const wsConfig = loadWorkspaceConfig(workspaceRootPath)
        const wsDefaultWorkingDir = wsConfig?.defaults?.workingDirectory

        for (const meta of sessionMetadata) {
          // Create managed session from metadata only (messages lazy-loaded on demand)
          // This dramatically reduces memory usage at startup - messages are loaded
          // when getSession() is called for a specific session
          const managed: ManagedSession = {
            id: meta.id,
            workspace,
            agent: null,  // Lazy-load agent when needed
            messages: [],  // Lazy-load messages when needed
            isProcessing: false,
            lastMessageAt: meta.lastMessageAt ?? meta.lastUsedAt,  // Fallback for sessions saved before lastMessageAt was persisted
            streamingText: '',
            processingGeneration: 0,
            name: meta.name,
            preview: meta.preview,
            createdAt: meta.createdAt,
            messageCount: meta.messageCount,
            isFlagged: meta.isFlagged ?? false,
            isArchived: meta.isArchived,
            archivedAt: meta.archivedAt,
            permissionMode: meta.permissionMode,
            sdkSessionId: meta.sdkSessionId,
            tokenUsage: meta.tokenUsage,  // From JSONL header (updated on save)
            todoState: meta.todoState,
            lastReadMessageId: meta.lastReadMessageId,  // Pre-computed for unread detection
            lastFinalMessageId: meta.lastFinalMessageId,  // Pre-computed for unread detection
            hasUnread: meta.hasUnread,  // Explicit unread flag for NEW badge state machine
            enabledSourceSlugs: undefined,  // Loaded with messages
            labels: meta.labels,
            workingDirectory: meta.workingDirectory ?? wsDefaultWorkingDir,
            sdkCwd: meta.sdkCwd,
            model: meta.model,
            llmProvider: meta.llmProvider,
            llmConnection: meta.llmConnection,
            connectionLocked: meta.connectionLocked,
            thinkingLevel: meta.thinkingLevel,
            lastMessageRole: meta.lastMessageRole,
            messageQueue: [],
            backgroundShellCommands: new Map(),
            messagesLoaded: false,  // Mark as not loaded
            // Shared viewer state - loaded from metadata for persistence across restarts
            sharedUrl: meta.sharedUrl,
            sharedId: meta.sharedId,
            hidden: meta.hidden,
            // Agent team fields (must be loaded for team grouping to persist across restarts)
            teamId: meta.teamId,
            isTeamLead: meta.isTeamLead,
            parentSessionId: meta.parentSessionId,
            teammateName: meta.teammateName,
            teammateSessionIds: meta.teammateSessionIds,
            teamColor: meta.teamColor,
            sddEnabled: meta.sddEnabled,
            activeSpecId: meta.activeSpecId,
            sddComplianceReports: meta.sddComplianceReports,
            // Initialize TokenRefreshManager for this session
            tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
              log: (msg) => sessionLog.debug(msg),
            }),
          }

          // Migration: clear orphaned llmConnection references (e.g., after connection was deleted)
          if (managed.llmConnection) {
            const conn = resolveSessionConnection(managed.llmConnection, undefined)
            if (!conn) {
              sessionLog.warn(`Session ${meta.id} has orphaned llmConnection "${managed.llmConnection}", clearing`)
              managed.llmConnection = undefined
              managed.connectionLocked = false
            }
          }

          this.sessions.set(meta.id, managed)

          // Initialize session metadata in HookSystem for diffing
          const hookSystem = this.hookSystems.get(workspaceRootPath)
          if (hookSystem) {
            hookSystem.setInitialSessionMetadata(meta.id, {
              permissionMode: meta.permissionMode,
              labels: meta.labels,
              isFlagged: meta.isFlagged,
              todoState: meta.todoState,
              sessionName: managed.name,
            })
          }

          totalSessions++
        }
      }

      // Repair agent-team links on startup in case a prior crash interrupted
      // metadata persistence (e.g., missing teammateSessionIds on lead sessions).
      this.repairTeamSessionLinks()

      sessionLog.info(`Loaded ${totalSessions} sessions from disk (metadata only)`)
    } catch (error) {
      sessionLog.error('Failed to load sessions from disk:', error)
    }
  }

  /**
   * Best-effort repair for team metadata consistency after loading sessions.
   * This keeps team grouping stable in the sidebar after crashes/restarts.
   */
  private repairTeamSessionLinks(): void {
    let repairedLeads = 0
    let repairedTeammates = 0

    const leadsByTeamId = new Map<string, ManagedSession>()
    for (const session of this.sessions.values()) {
      if (session.isTeamLead && session.teamId) {
        leadsByTeamId.set(session.teamId, session)
      }
    }

    // Fill missing parent/team metadata on teammate sessions when we can infer it
    for (const teammate of this.sessions.values()) {
      if (teammate.isTeamLead) continue

      if (!teammate.parentSessionId && teammate.teamId) {
        const inferredLead = leadsByTeamId.get(teammate.teamId)
        if (inferredLead && inferredLead.id !== teammate.id) {
          teammate.parentSessionId = inferredLead.id
          teammate.teamColor = teammate.teamColor ?? inferredLead.teamColor
          repairedTeammates++
          this.persistSession(teammate)
        }
      }
    }

    // Rebuild lead -> teammate mapping from child parentSessionId references
    const teammateIdsByLead = new Map<string, string[]>()
    for (const teammate of this.sessions.values()) {
      if (!teammate.parentSessionId) continue
      const arr = teammateIdsByLead.get(teammate.parentSessionId) ?? []
      arr.push(teammate.id)
      teammateIdsByLead.set(teammate.parentSessionId, arr)
    }

    for (const lead of this.sessions.values()) {
      const rebuilt = teammateIdsByLead.get(lead.id) ?? []
      if (rebuilt.length === 0) continue

      const existing = lead.teammateSessionIds ?? []
      const isSameLength = existing.length === rebuilt.length
      const hasSameMembers = isSameLength && rebuilt.every(id => existing.includes(id))

      const shouldRepair = !lead.isTeamLead || !hasSameMembers
      if (shouldRepair) {
        lead.isTeamLead = true
        lead.teammateSessionIds = rebuilt
        repairedLeads++
        this.persistSession(lead)
      }

      // Also propagate lead team metadata down to teammates when missing
      for (const teammateId of rebuilt) {
        const teammate = this.sessions.get(teammateId)
        if (!teammate) continue

        let teammateChanged = false
        if (!teammate.teamId && lead.teamId) {
          teammate.teamId = lead.teamId
          teammateChanged = true
        }
        if (!teammate.teamColor && lead.teamColor) {
          teammate.teamColor = lead.teamColor
          teammateChanged = true
        }
        if (teammateChanged) {
          repairedTeammates++
          this.persistSession(teammate)
        }
      }
    }

    if (repairedLeads > 0 || repairedTeammates > 0) {
      sessionLog.warn(`[AgentTeams] Repaired team links after startup (leads=${repairedLeads}, teammates=${repairedTeammates})`)
    }
  }

  // Persist a session to disk (async with debouncing)
  private persistSession(managed: ManagedSession): void {
    try {
      // Filter out transient status messages (progress indicators like "Compacting...")
      // Error messages are now persisted with rich fields for diagnostics
      const persistableMessages = managed.messages.filter(m =>
        m.role !== 'status'
      )

      const workspaceRootPath = managed.workspace.rootPath
      const storedSession: StoredSession = {
        id: managed.id,
        workspaceRootPath,
        name: managed.name,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        lastMessageAt: managed.lastMessageAt,  // Preserve actual message time (not persist time)
        sdkSessionId: managed.sdkSessionId,
        isFlagged: managed.isFlagged,
        isArchived: managed.isArchived,
        archivedAt: managed.archivedAt,
        permissionMode: managed.permissionMode,
        todoState: managed.todoState,
        lastReadMessageId: managed.lastReadMessageId,  // For unread detection
        hasUnread: managed.hasUnread,  // Explicit unread flag for NEW badge state machine
        enabledSourceSlugs: managed.enabledSourceSlugs,
        labels: managed.labels,
        workingDirectory: managed.workingDirectory,
        sdkCwd: managed.sdkCwd,
        model: managed.model,
        llmProvider: managed.llmProvider,
        llmConnection: managed.llmConnection,
        connectionLocked: managed.connectionLocked,
        // Agent team fields
        teamId: managed.teamId,
        isTeamLead: managed.isTeamLead,
        parentSessionId: managed.parentSessionId,
        teammateName: managed.teammateName,
        teammateSessionIds: managed.teammateSessionIds,
        teamColor: managed.teamColor,
        sddEnabled: managed.sddEnabled,
        activeSpecId: managed.activeSpecId,
        sddComplianceReports: managed.sddComplianceReports,
        thinkingLevel: managed.thinkingLevel,
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          costUsd: 0,
        },
        hidden: managed.hidden,
      }

      // Queue for async persistence with debouncing
      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      sessionLog.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
  }

  // Flush a specific session immediately (call on session close/switch)
  async flushSession(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  // Flush all pending sessions (call on app quit)
  async flushAllSessions(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  // ============================================
  // Unified Auth Request Helpers
  // ============================================

  /**
   * Get human-readable description for auth request
   */
  private getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  private formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }

  /**
   * Run OAuth flow for a given auth request (non-credential types)
   * Called after forceAbort to execute the OAuth flow asynchronously
   */
  private async runOAuthFlow(managed: ManagedSession, request: AuthRequest): Promise<void> {
    if (request.type === 'credential') return // Credentials handled by UI

    sessionLog.info(`Running OAuth flow for ${request.sourceSlug} (type: ${request.type})`)

    // Find the source in workspace sources
    const sources = loadWorkspaceSources(managed.workspace.rootPath)
    const source = sources.find(s => s.config.slug === request.sourceSlug)

    if (!source) {
      sessionLog.error(`Source ${request.sourceSlug} not found for OAuth`)
      await this.completeAuthRequest(managed.id, {
        requestId: request.requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: `Source ${request.sourceSlug} not found`,
      })
      return
    }

    // Get credential manager and run OAuth
    const credManager = getSourceCredentialManager()

    try {
      const result = await credManager.authenticate(source, {
        onStatus: (msg) => sessionLog.info(`[OAuth ${request.sourceSlug}] ${msg}`),
        onError: (err) => sessionLog.error(`[OAuth ${request.sourceSlug}] ${err}`),
      }, {
        sessionId: managed.id,
        deeplinkScheme: process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents',
      })

      if (result.success) {
        await this.completeAuthRequest(managed.id, {
          requestId: request.requestId,
          sourceSlug: request.sourceSlug,
          success: true,
          email: result.email,
        })
      } else {
        await this.completeAuthRequest(managed.id, {
          requestId: request.requestId,
          sourceSlug: request.sourceSlug,
          success: false,
          error: result.error,
        })
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      sessionLog.error(`OAuth flow failed for ${request.sourceSlug}:`, errorMessage)
      await this.completeAuthRequest(managed.id, {
        requestId: request.requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: errorMessage,
      })
    }
  }

  /**
   * Start OAuth flow for a pending auth request (called when user clicks "Sign in")
   * This is the user-initiated trigger - OAuth no longer starts automatically
   */
  async startSessionOAuth(sessionId: string, requestId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot start OAuth - session ${sessionId} not found`)
      return
    }

    // Find the pending auth request
    if (managed.pendingAuthRequestId !== requestId || !managed.pendingAuthRequest) {
      sessionLog.warn(`Cannot start OAuth - no pending request with id ${requestId}`)
      return
    }

    const request = managed.pendingAuthRequest
    if (request.type === 'credential') {
      sessionLog.warn(`Cannot start OAuth for credential request`)
      return
    }

    // Run the OAuth flow
    await this.runOAuthFlow(managed, request)
  }

  /**
   * Complete an auth request and send result back to agent
   * This updates the auth message status and sends a faked user message
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(m =>
      m.role === 'auth-request' &&
      m.authRequestId === result.requestId &&
      m.authStatus === 'pending'
    )

    if (authMessage) {
      authMessage.authStatus = result.success ? 'completed' :
                               result.cancelled ? 'cancelled' : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // Emit auth_completed event to update UI
    this.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    }, managed.workspace.id)

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // Persist session with updated auth message
    this.persistSession(managed)

    // Send the result as a new message to resume conversation
    // Use empty arrays for attachments since this is a system-generated message
    await this.sendMessage(sessionId, resultContent, [], [], {})

    sessionLog.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth)
   * Called when user submits credentials via the inline form
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: import('../shared/types').CredentialResponse
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.pendingAuthRequest) {
      sessionLog.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      sessionLog.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const credManager = getCredentialManager()
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        // Store value as JSON string {username, password} - credential-manager.ts parses it for basic auth
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        // Store multi-header credentials as JSON { "DD-API-KEY": "...", "DD-APPLICATION-KEY": "..." }
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify(response.headers) }
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      sessionLog.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  /**
   * Reload all sessions from disk.
   * Used after importing sessions to refresh the in-memory session list.
   */
  reloadSessions(): void {
    this.loadSessionsFromDisk()
  }

  getSessions(workspaceId?: string): Session[] {
    // Returns session metadata only - messages are NOT included to save memory
    // Use getSession(id) to load messages for a specific session
    let sessions = Array.from(this.sessions.values())

    // Filter by workspace if specified (used when switching workspaces)
    if (workspaceId) {
      sessions = sessions.filter(m => m.workspace.id === workspaceId)
    }

    return sessions
      .map(m => ({
        // Persistent fields (auto-included via pickSessionFields)
        ...pickSessionFields(m),
        // Pre-computed fields from header
        preview: m.preview,
        lastMessageRole: m.lastMessageRole,
        tokenUsage: m.tokenUsage,
        messageCount: m.messageCount,
        lastFinalMessageId: m.lastFinalMessageId,
        hidden: m.hidden,
        // Agent team fields
        teamId: m.teamId,
        isTeamLead: m.isTeamLead,
        parentSessionId: m.parentSessionId,
        teammateName: m.teammateName,
        teammateSessionIds: m.teammateSessionIds,
        teamColor: m.teamColor,
        // Runtime-only fields
        workspaceId: m.workspace.id,
        workspaceName: m.workspace.name,
        messages: [],  // Never send all messages - use getSession(id) for specific session
        isProcessing: m.isProcessing,
      }) as Session)
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
  }

  private detectProcessRole(commandLine: string): 'app-server' | 'bridge-mcp' | 'session-mcp' | 'other' {
    const normalized = commandLine.toLowerCase()
    if (normalized.includes('app-server')) return 'app-server'
    if (normalized.includes('bridge-mcp-server')) return 'bridge-mcp'
    if (normalized.includes('session-mcp-server')) return 'session-mcp'
    return 'other'
  }

  private parseCreatedAtMs(createdAt?: string): number {
    if (!createdAt) return 0
    const direct = Date.parse(createdAt)
    if (!Number.isNaN(direct)) return direct

    // Win32_Process.CreationDate format: yyyyMMddHHmmss.mmmmmm+UUU
    const match = createdAt.match(/^(\d{14})/)
    if (!match) return 0
    const stamp = match[1]
    const yyyy = Number(stamp.slice(0, 4))
    const mm = Number(stamp.slice(4, 6)) - 1
    const dd = Number(stamp.slice(6, 8))
    const hh = Number(stamp.slice(8, 10))
    const min = Number(stamp.slice(10, 12))
    const ss = Number(stamp.slice(12, 14))
    return new Date(yyyy, mm, dd, hh, min, ss).getTime()
  }

  private async listRuntimeProcesses(): Promise<RuntimeProcessRow[]> {
    if (process.platform === 'win32') {
      const script = [
        '$ErrorActionPreference = "Stop"',
        '$rows = Get-CimInstance Win32_Process |',
        '  Where-Object { $_.Name -in @("node.exe", "bun.exe", "bunx.exe") } |',
        '  Select-Object @{Name="pid";Expression={$_.ProcessId}},',
        '                @{Name="parentPid";Expression={$_.ParentProcessId}},',
        '                @{Name="name";Expression={$_.Name}},',
        '                @{Name="commandLine";Expression={$_.CommandLine}},',
        '                @{Name="createdAt";Expression={$_.CreationDate}}',
        '$rows | ConvertTo-Json -Compress',
      ].join('; ')

      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script], {
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      if (!stdout.trim()) return []
      const parsed = JSON.parse(stdout.trim()) as RuntimeProcessRow | RuntimeProcessRow[]
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows.filter((row): row is RuntimeProcessRow =>
        typeof row?.pid === 'number' && typeof row?.name === 'string' && typeof row?.commandLine === 'string'
      )
    }

    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,ppid=,comm=,command='], {
      maxBuffer: 8 * 1024 * 1024,
    })

    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line): RuntimeProcessRow | null => {
        const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
        if (!match) return null
        const pid = Number(match[1])
        const parentPid = Number(match[2])
        const name = match[3]
        const commandLine = match[4]
        return Number.isFinite(pid) && Number.isFinite(parentPid)
          ? { pid, parentPid, name, commandLine }
          : null
      })
      .filter((row): row is RuntimeProcessRow => row !== null)
      .filter(row => /node|bun/i.test(row.name))
  }

  private async terminateProcess(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
      })
      return
    }

    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process may have already exited
    }
  }

  async reapStaleSessionProcesses(options?: SessionProcessReapOptions): Promise<SessionProcessReapReport> {
    const forceKill = options?.forceKill === true
    const dryRun = forceKill ? false : options?.dryRun !== false
    const activeSessionIds = Array.from(this.sessions.keys())
    const activeSessionSet = new Set(activeSessionIds)
    const errors: string[] = []
    const candidates: SessionProcessCandidate[] = []
    let rows: RuntimeProcessRow[] = []

    try {
      rows = await this.listRuntimeProcesses()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push(`Failed to list runtime processes: ${message}`)
      return {
        scannedAt: new Date().toISOString(),
        dryRun,
        forceKill,
        scannedProcessCount: 0,
        candidateCount: 0,
        terminatedCount: 0,
        activeSessionIds,
        candidates: [],
        errors,
      }
    }

    const trackedRows = rows.filter(row => {
      const command = row.commandLine.toLowerCase()
      if (!command) return false
      const hasSessionRef = command.includes('--session-id') || /[\\/]sessions[\\/]/.test(command)
      const hasCraftRef = /(craft-agent|craftagents|app-server|session-mcp-server|bridge-mcp-server|codex)/.test(command)
      return hasSessionRef || hasCraftRef
    })

    const bySessionAndRole = new Map<string, RuntimeProcessRow[]>()

    for (const row of trackedRows) {
      const sessionId = extractSessionIdFromCommand(row.commandLine)
      if (!sessionId) continue

      if (!activeSessionSet.has(sessionId)) {
        candidates.push({
          pid: row.pid,
          processName: row.name,
          sessionId,
          reason: 'missing_session',
          createdAt: row.createdAt,
          commandPreview: commandPreview(row.commandLine),
        })
        continue
      }

      const role = this.detectProcessRole(row.commandLine)
      if (role !== 'app-server') continue
      const key = `${sessionId}:${role}`
      const existing = bySessionAndRole.get(key) ?? []
      existing.push(row)
      bySessionAndRole.set(key, existing)
    }

    for (const [key, entries] of bySessionAndRole.entries()) {
      if (entries.length <= 1) continue
      const [sessionId] = key.split(':')
      const managed = this.sessions.get(sessionId)
      if (!managed || managed.isProcessing) continue

      const sorted = [...entries].sort((a, b) => this.parseCreatedAtMs(b.createdAt) - this.parseCreatedAtMs(a.createdAt))
      const stale = sorted.slice(1) // keep newest app-server process
      for (const row of stale) {
        candidates.push({
          pid: row.pid,
          processName: row.name,
          sessionId,
          reason: 'duplicate_idle_session',
          createdAt: row.createdAt,
          commandPreview: commandPreview(row.commandLine),
        })
      }
    }

    let terminatedCount = 0
    if (forceKill && !dryRun) {
      for (const candidate of candidates) {
        try {
          await this.terminateProcess(candidate.pid)
          terminatedCount++
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          errors.push(`Failed to terminate PID ${candidate.pid}: ${message}`)
        }
      }
    }

    const report: SessionProcessReapReport = {
      scannedAt: new Date().toISOString(),
      dryRun,
      forceKill,
      scannedProcessCount: trackedRows.length,
      candidateCount: candidates.length,
      terminatedCount,
      activeSessionIds,
      candidates,
      errors,
    }

    sessionLog.info(
      `[ProcessReaper] scanned=${report.scannedProcessCount} candidates=${report.candidateCount} ` +
      `terminated=${report.terminatedCount} dryRun=${report.dryRun}`
    )

    return report
  }

  /**
   * Refresh in-memory agent instances for a workspace so runtime callbacks
   * (including agent teams interception hooks) reflect latest settings.
   */
  private destroyManagedAgent(managed: ManagedSession, reason: string): void {
    if (!managed.agent) return
    try {
      managed.agent.dispose()
    } catch (error) {
      sessionLog.warn(`Failed to dispose agent for session ${managed.id} (${reason}):`, error)
    } finally {
      managed.agent = null
      unregisterSessionScopedToolCallbacks(managed.id)
      sessionLog.info(`Disposed agent for session ${managed.id} (${reason})`)
    }
  }

  refreshWorkspaceAgentRuntime(workspaceId: string, reason: string): void {
    let refreshed = 0
    let skipped = 0

    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) {
        skipped++
        continue
      }
      if (managed.agent) {
        this.destroyManagedAgent(managed, `refreshWorkspaceAgentRuntime:${reason}`)
        refreshed++
      }
    }

    sessionLog.info(`[AgentTeams] Runtime refresh for workspace ${workspaceId} (${reason}) refreshed=${refreshed} skipped_processing=${skipped}`)
  }

  /**
   * Get a single session by ID with all messages loaded.
   * Used for lazy loading session messages when session is selected.
   * Messages are loaded from disk on first access to reduce memory usage.
   */
  async getSession(sessionId: string): Promise<Session | null> {
    const m = this.sessions.get(sessionId)
    if (!m) return null

    // Lazy-load messages from disk if not yet loaded
    await this.ensureMessagesLoaded(m)

    return {
      // Persistent fields (auto-included via pickSessionFields)
      ...pickSessionFields(m),
      // Pre-computed fields from header
      preview: m.preview,  // Include preview for title fallback consistency with getSessions()
      lastMessageRole: m.lastMessageRole,
      tokenUsage: m.tokenUsage,
      lastFinalMessageId: m.lastFinalMessageId,
      hidden: m.hidden,
      // Agent team fields
      teamId: m.teamId,
      isTeamLead: m.isTeamLead,
      parentSessionId: m.parentSessionId,
      teammateName: m.teammateName,
      teammateSessionIds: m.teammateSessionIds,
      teamColor: m.teamColor,
      // Runtime-only fields
      workspaceId: m.workspace.id,
      workspaceName: m.workspace.name,
      messages: m.messages,
      isProcessing: m.isProcessing,
      sessionFolderPath: getSessionStoragePath(m.workspace.rootPath, m.id),
    } as Session
  }

  /**
   * Get unified usage summary for a session.
   * Falls back to persisted tokenUsage when per-turn usage summary hasn't been built yet.
   */
  getSessionUsage(sessionId: string): SessionUsage | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    const summary = this.ensureUsageSummary(managed)

    // Backfill from persisted tokenUsage for sessions loaded from disk before provider-aware tracking existed.
    if (summary.totalCalls === 0 && managed.tokenUsage) {
      const provider = this.resolveSessionProvider(managed)
      const inputTokens = managed.tokenUsage.inputTokens || 0
      const outputTokens = managed.tokenUsage.outputTokens || 0
      const costUsd = managed.tokenUsage.costUsd || calculateTokenCostUsd({
        model: managed.model,
        provider,
        inputTokens,
        outputTokens,
        cachedInputTokens: managed.tokenUsage.cacheReadTokens,
      })

      summary.providers[provider].callCount = Math.max(summary.providers[provider].callCount, outputTokens > 0 || inputTokens > 0 ? 1 : 0)
      summary.providers[provider].inputTokens = Math.max(summary.providers[provider].inputTokens, inputTokens)
      summary.providers[provider].outputTokens = Math.max(summary.providers[provider].outputTokens, outputTokens)
      summary.providers[provider].estimatedCostUsd = Math.max(summary.providers[provider].estimatedCostUsd, costUsd)
      summary.totalCalls = Object.values(summary.providers).reduce((sum, p) => sum + p.callCount, 0)
      summary.lastUpdatedAt = new Date().toISOString()
    }

    // Refresh team rollup for lead sessions
    if (managed.isTeamLead && managed.teammateSessionIds?.length) {
      this.updateLeadTeamUsageFromTeammate(managed)
    }

    return JSON.parse(JSON.stringify(summary)) as SessionUsage
  }

  /**
   * Ensure messages are loaded for a managed session.
   * Uses promise deduplication to prevent race conditions when multiple
   * concurrent calls (e.g., rapid session switches + message send) try
   * to load messages simultaneously.
   */
  private async ensureMessagesLoaded(managed: ManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    // Deduplicate concurrent loads - return existing promise if already loading
    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  /**
   * Internal: Load messages from disk storage into the managed session.
   */
  private async loadMessagesFromDisk(managed: ManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      const maxLoadedMessages = 500
      const storedMessages = storedSession.messages || []
      const slicedMessages = storedMessages.length > maxLoadedMessages
        ? storedMessages.slice(-maxLoadedMessages)
        : storedMessages
      managed.messages = slicedMessages.map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread  // Explicit unread flag for NEW badge state machine
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      managed.sddEnabled = storedSession.sddEnabled
      managed.activeSpecId = storedSession.activeSpecId
      managed.sddComplianceReports = storedSession.sddComplianceReports
      // Sync name from disk - ensures title persistence across lazy loading
      managed.name = storedSession.name
      // Restore LLM connection state - ensures correct provider on resume
      if (storedSession.llmProvider) {
        managed.llmProvider = storedSession.llmProvider
      }
      if (storedSession.llmConnection) {
        managed.llmConnection = storedSession.llmConnection
      }
      if (storedSession.connectionLocked) {
        managed.connectionLocked = storedSession.connectionLocked
      }
      if (storedMessages.length > maxLoadedMessages) {
        sessionLog.info(`Lazy-loaded last ${managed.messages.length} of ${storedMessages.length} messages for session ${managed.id}`)
      } else {
        sessionLog.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)
      }

      // Queue recovery: find orphaned queued messages from crash/restart and re-queue them
      const orphanedQueued = managed.messages.filter(m =>
        m.role === 'user' && m.isQueued === true
      )
      if (orphanedQueued.length > 0) {
        sessionLog.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        for (const msg of orphanedQueued) {
          managed.messageQueue.push({
            message: msg.content,
            messageId: msg.id,
            attachments: undefined,  // Attachments already stored on disk
            storedAttachments: msg.attachments,
            options: msg.ultrathink ? { ultrathinkEnabled: true } : undefined,
          })
        }
        // Process queue when session becomes active (will be triggered by first message or interaction)
        // Use setImmediate to avoid blocking the load and allow session state to settle
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => {
            this.processNextQueuedMessage(managed.id)
          })
        }
      }
    }
    managed.messagesLoaded = true
  }

  /**
   * Get the filesystem path to a session's folder
   */
  getSessionPath(sessionId: string): string | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getSessionStoragePath(managed.workspace.rootPath, sessionId)
  }

  async createSession(workspaceId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    // Get new session defaults from workspace config (with global fallback)
    // Options.permissionMode overrides the workspace default (used by EditPopover for auto-execute)
    const workspaceRootPath = workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const globalDefaults = loadConfigDefaults()

    // Read permission mode from workspace config, fallback to global defaults
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    // Get default thinking level from workspace config, fallback to global defaults
    const defaultThinkingLevel = wsConfig?.defaults?.thinkingLevel ?? globalDefaults.workspaceDefaults.thinkingLevel
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    // Get default SDD mode from workspace config
    const defaultSddEnabled = options?.sddEnabled ?? wsConfig?.sdd?.sddEnabled ?? false
    const defaultSpecId = options?.activeSpecId
    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs

    // Resolve working directory from options:
    // - 'user_default' or undefined: Use workspace's configured default
    // - 'none': No working directory (empty string means session folder only)
    // - Absolute path: Use as-is
    let resolvedWorkingDir: string | undefined
    if (options?.workingDirectory === 'none') {
      resolvedWorkingDir = undefined  // No working directory
    } else if (options?.workingDirectory === 'user_default' || options?.workingDirectory === undefined) {
      resolvedWorkingDir = userDefaultWorkingDir
    } else {
      resolvedWorkingDir = options.workingDirectory
    }

    // Use storage layer to create and persist the session
    const storedSession = await createStoredSession(workspaceRootPath, {
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      llmProvider: options?.llmProvider,
      hidden: options?.hidden,
      todoState: options?.todoState,
      labels: options?.labels,
      isFlagged: options?.isFlagged,
      // Agent team fields
      teamId: options?.teamId,
      isTeamLead: options?.isTeamLead,
      parentSessionId: options?.parentSessionId,
      teammateName: options?.teammateName,
      teamColor: options?.teamColor,
    })

    // Resolve connection to determine provider for model compatibility check
    const sessionConnection = resolveSessionConnection(
      options?.llmConnection,
      wsConfig?.defaults?.defaultLlmConnection
    )
    const sessionProvider = sessionConnection
      ? providerTypeToAgentProvider(sessionConnection.providerType || 'anthropic')
      : 'anthropic'

    // Model priority: options.model > storedSession.model > workspace default
    let resolvedModel = options?.model || storedSession.model || defaultModel

    // Ensure model matches the connection's provider (e.g. don't send Claude model to Codex)
    // Fall back to connection's default model instead of hardcoded constants
    if (resolvedModel && sessionProvider === 'openai' && !isCodexModel(resolvedModel)) {
      resolvedModel = sessionConnection?.defaultModel ?? resolvedModel
    } else if (resolvedModel && sessionProvider === 'anthropic' && isCodexModel(resolvedModel)) {
      resolvedModel = sessionConnection?.defaultModel ?? resolvedModel
    }

    const resolvedLlmProvider: UsageProvider = (() => {
      const providerType = sessionConnection?.providerType
      if (providerType === 'openai') return 'openai'
      if (providerType === 'openai_compat') return inferProviderFromModel(resolvedModel)
      if (providerType === 'anthropic' || providerType === 'anthropic_compat' || providerType === 'bedrock' || providerType === 'vertex') {
        return 'anthropic'
      }
      return inferProviderFromModel(resolvedModel)
    })()

    // Log mini agent session creation
    if (options?.systemPromptPreset === 'mini' || options?.model) {
      sessionLog.info(`🤖 Creating mini agent session: model=${resolvedModel}, systemPromptPreset=${options?.systemPromptPreset}`)
    }

    const managed: ManagedSession = {
      id: storedSession.id,
      workspace,
      agent: null,  // Lazy-load agent on first message
      messages: [],
      isProcessing: false,
      lastMessageAt: storedSession.lastMessageAt ?? storedSession.lastUsedAt,  // Fallback for sessions saved before lastMessageAt was persisted
      streamingText: '',
      processingGeneration: 0,
      isFlagged: options?.isFlagged ?? false,
      todoState: options?.todoState,
      labels: options?.labels,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      sdkCwd: storedSession.sdkCwd,
      // Session-specific model takes priority, then workspace default
      model: resolvedModel,
      llmProvider: resolvedLlmProvider,
      // LLM connection - initially undefined, will be set when model is selected
      // This allows the connection to be locked after first message
      llmConnection: options?.llmConnection,
      thinkingLevel: defaultThinkingLevel,
      // System prompt preset for mini agents
      systemPromptPreset: options?.systemPromptPreset,
      messageQueue: [],
      backgroundShellCommands: new Map(),
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      messagesLoaded: true,  // New sessions don't need to load messages from disk
      hidden: options?.hidden,
      // Agent team fields
      teamId: options?.teamId,
      isTeamLead: options?.isTeamLead,
      parentSessionId: options?.parentSessionId,
      teammateName: options?.teammateName,
      teamColor: options?.teamColor,
      sddEnabled: defaultSddEnabled,
      activeSpecId: defaultSpecId,
      sddComplianceReports: [],
      // Initialize TokenRefreshManager for this session (handles OAuth token refresh with rate limiting)
      tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
        log: (msg) => sessionLog.debug(msg),
      }),
    }

    this.sessions.set(storedSession.id, managed)
    this.persistSession(managed)

    if (defaultSddEnabled && !defaultSpecId) {
      await this.ensureSessionActiveSpec(storedSession.id)
    }
    if (defaultSddEnabled) {
      this.startComplianceWatcher(storedSession.id)
    }

    // Initialize session metadata in HookSystem for diffing
    const hookSystem = this.hookSystems.get(workspaceRootPath)
    if (hookSystem) {
      hookSystem.setInitialSessionMetadata(storedSession.id, {
        permissionMode: storedSession.permissionMode,
        labels: storedSession.labels,
        isFlagged: storedSession.isFlagged,
        todoState: storedSession.todoState,
        sessionName: managed.name,
      })
    }

    return {
      id: storedSession.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      lastMessageAt: managed.lastMessageAt,
      messages: [],
      isProcessing: false,
      isFlagged: options?.isFlagged ?? false,
      permissionMode: defaultPermissionMode,
      todoState: options?.todoState,
      labels: options?.labels,
      workingDirectory: resolvedWorkingDir,
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      model: managed.model,
      llmProvider: managed.llmProvider,
      thinkingLevel: defaultThinkingLevel,
      sessionFolderPath: getSessionStoragePath(workspaceRootPath, storedSession.id),
      hidden: options?.hidden,
      // Agent team fields
      teamId: options?.teamId,
      isTeamLead: options?.isTeamLead,
      parentSessionId: options?.parentSessionId,
      teammateName: options?.teammateName,
      teamColor: options?.teamColor,
      sddEnabled: defaultSddEnabled,
      activeSpecId: managed.activeSpecId,
      sddComplianceReports: [],
    }
  }

  /**
   * Find the lead session for a given team ID.
   * Returns the session with isTeamLead=true and matching teamId, or null if not found.
   */
  findLeadSessionForTeam(teamId: string): { id: string; workspaceId: string } | null {
    for (const [, session] of this.sessions) {
      if (session.isTeamLead && session.teamId === teamId) {
        return { id: session.id, workspaceId: session.workspace.id }
      }
    }
    return null
  }

  /**
   * Create a separate session for an agent team teammate.
   * The teammate gets its own CraftAgent, SDK subprocess, and context window.
   */
  async createTeammateSession(params: {
    parentSessionId: string
    workspaceId: string
    teamId: string
    /** Teammate name - if undefined, a witty codename will be generated */
    teammateName: string | undefined
    prompt: string
    model?: string
    llmConnection?: string
    role?: TeamRole
  }): Promise<import('../shared/types').Session> {
    const parent = this.sessions.get(params.parentSessionId)
    if (!parent) {
      throw new Error(`Parent session ${params.parentSessionId} not found`)
    }

    // Pick team color: count existing teams to rotate through the palette
    let teamColor = parent.teamColor
    if (!teamColor) {
      const activeTeamIds = new Set<string>()
      for (const [, s] of this.sessions) {
        if (s.teamId) activeTeamIds.add(s.teamId)
      }
      teamColor = TEAM_COLORS[activeTeamIds.size % TEAM_COLORS.length]
      // Set the color on the parent/lead session too
      parent.teamColor = teamColor
      parent.teamId = params.teamId
      parent.isTeamLead = true

      // Upgrade lead session model to the preset's lead model
      const wsConfigForLead = loadWorkspaceConfig(parent.workspace.rootPath)
      const leadAssignment = resolveTeamModelForRole(wsConfigForLead, 'lead')
      const leadModel = leadAssignment.model
      if (leadModel && leadModel !== 'unknown' && leadModel !== parent.model) {
        const leadConnectionSlug = resolveConnectionForModel({
          model: leadModel,
          parentConnectionSlug: parent.llmConnection,
          workspaceDefaultSlug: wsConfigForLead?.defaults?.defaultLlmConnection,
        })
        const resolvedConn = leadConnectionSlug ? getLlmConnection(leadConnectionSlug) : null
        if (resolvedConn && connectionSupportsModel(resolvedConn, leadModel)) {
          sessionLog.info(`[AgentTeams] Upgrading lead session model from "${parent.model}" to preset lead model "${leadModel}"`)
          parent.model = leadModel
          parent.llmConnection = leadConnectionSlug!
          parent.llmProvider = resolveUsageProvider(resolvedConn.providerType, leadModel)
          if (parent.agent) {
            parent.agent.setModel(leadModel)
          }
          // Persist and notify renderer
          updateSessionMetadata(parent.workspace.rootPath, parent.id, {
            model: parent.model,
            llmProvider: parent.llmProvider,
            llmConnection: parent.llmConnection,
          })
          this.sendEvent({ type: 'session_model_changed', sessionId: parent.id, model: parent.model }, parent.workspace.id)
        }
      }
    }

    // Create the teammate session
    const workspaceConfig = loadWorkspaceConfig(parent.workspace.rootPath)
    // Implements REQ-003: ensure an active spec when SDD is enabled
    if (parent.sddEnabled && !parent.activeSpecId) {
      await this.ensureSessionActiveSpec(parent.id)
    }
    if (parent.sddEnabled && !parent.activeSpecId) {
      throw new Error('SDD is enabled for this session. Set an active spec before spawning teammates.')
    }
    const teammateRole = normalizeTeamRole(params.role)
    const teammateOrdinal = (parent.teammateSessionIds?.length ?? 0) + 1
    const teammateCodename = buildTeammateCodename(teammateRole, teammateOrdinal - 1)
    // Implements REQ-002: Use witty codename as primary name, honor explicit custom names
    const customName = params.teammateName?.trim()
    const teammateDisplayName = customName || teammateCodename
    const isAutoGenerated = !customName

    if (params.role && params.role !== teammateRole) {
      sessionLog.warn(`[AgentTeams] Unknown teammate role "${params.role}" requested; defaulting to "${teammateRole}"`)
    }
    if (isAutoGenerated) {
      sessionLog.info(`[AgentTeams] No teammate name provided; generated codename: ${teammateCodename}`)
    }
    // Implements REQ-002: honor workspace role model defaults and ignore conflicting overrides
    const requestedModel = params.model?.trim()
    const normalizedRequestedModel = requestedModel && requestedModel !== 'auto'
      ? requestedModel
      : undefined
    const resolvedAssignment = resolveTeamModelForRole(workspaceConfig, teammateRole, undefined, parent.model)
    const configuredModel = resolvedAssignment.model && resolvedAssignment.model !== 'unknown'
      ? resolvedAssignment.model
      : undefined
    if (configuredModel && normalizedRequestedModel && normalizedRequestedModel !== configuredModel) {
      sessionLog.info(
        `[AgentTeams] Ignoring model override "${normalizedRequestedModel}" for role ${teammateRole}; ` +
        `using workspace model "${configuredModel}".`
      )
    }

    // Implements REQ-001: honor workspace role model defaults for teammates
    const teammateModel = configuredModel ?? normalizedRequestedModel ?? parent.model ?? workspaceConfig?.defaults?.model ?? DEFAULT_MODEL

    if (!teammateModel) {
      throw new Error(
        `No model configured for teammate. Parent session "${parent.id}" has no model set.`
      )
    }

    sessionLog.info(`[AgentTeams] Resolved teammate spawn: name=${teammateDisplayName}${isAutoGenerated ? ' (auto-generated)' : ''} role=${teammateRole} model=${teammateModel}`)

    // Implements REQ-004: choose a provider/connection compatible with the resolved model
    const teammateConnectionSlug = resolveConnectionForModel({
      model: teammateModel,
      parentConnectionSlug: params.llmConnection ?? parent.llmConnection,
      workspaceDefaultSlug: workspaceConfig?.defaults?.defaultLlmConnection,
    })

    if (!teammateConnectionSlug) {
      // Implements REQ-004: fail fast when no compatible connection is configured
      throw new Error(
        `No LLM connection configured for model "${teammateModel}". ` +
        `Please add or update a connection that supports this model before spawning teammates.`
      )
    }

    const teammateConnection = teammateConnectionSlug
    const resolvedConnection = getLlmConnection(teammateConnection)
    if (!resolvedConnection || !connectionSupportsModel(resolvedConnection, teammateModel)) {
      throw new Error(
        `Connection "${teammateConnection}" does not support model "${teammateModel}". ` +
        `Please update the connection model list before spawning teammates.`
      )
    }

    sessionLog.info(`[AgentTeams] Using connection "${teammateConnection}" (${resolvedConnection.providerType}) for teammate "${teammateDisplayName}"`)


    const teammateSession = await this.createSession(params.workspaceId, {
      teamId: params.teamId,
      parentSessionId: params.parentSessionId,
      teammateName: teammateDisplayName,
      teammateRole,
      teamColor,
      permissionMode: 'allow-all',
      workingDirectory: parent.workingDirectory,
      model: teammateModel,
      llmConnection: teammateConnection,
      sddEnabled: parent.sddEnabled,
      activeSpecId: parent.activeSpecId,
    })
    await this.renameSession(teammateSession.id, teammateDisplayName)

    // Track teammate in parent
    if (!parent.teammateSessionIds) {
      parent.teammateSessionIds = []
    }
    parent.teammateSessionIds.push(teammateSession.id)

    // Persist parent with updated team fields
    this.persistSession(parent)

    // Emit team_session_created event to renderer
    this.sendEvent({
      type: 'team_session_created',
      sessionId: params.parentSessionId,
      teammateSessionId: teammateSession.id,
      teammateName: teammateDisplayName,
      teamId: params.teamId,
      teamColor,
    }, parent.workspace.id)

    // Implements REQ-001: emit team activity for spawn tracing
    const resolvedTeamId = teamManager.resolveTeamId(params.teamId)
    teamManager.logActivity(
      resolvedTeamId,
      'teammate-spawned',
      `${teammateDisplayName} spawned`,
      teammateSession.id,
      teammateDisplayName
    )

    // Start health monitoring for this team (no-op if already started)
    this.startTeamHealthMonitoring(resolvedTeamId, params.parentSessionId)
    this.healthMonitor.recordActivity(resolvedTeamId, teammateSession.id, teammateDisplayName, {
      type: 'task_update',
      taskId: params.prompt?.slice(0, 80) ?? 'unknown',
    })

    // Build compact spec context + task metadata for teammates when SDD is enabled
    let compactSpecContext: string | null = null
    let parsedSpec: Spec | null = null
    if (parent.sddEnabled && parent.activeSpecId && existsSync(parent.activeSpecId)) {
      try {
        const specContent = await readFile(parent.activeSpecId, 'utf-8')
        parsedSpec = parseSpecMarkdown(specContent, parent.activeSpecId)
        compactSpecContext = exportCompactSpec(parsedSpec)
      } catch (err) {
        sessionLog.warn(`[AgentTeams] Failed to build compact spec for ${parent.activeSpecId}:`, err)
      }
    }

    if (parent.sddEnabled && parsedSpec) {
      const requirementIds = parsedSpec.requirements.map(req => req.id)
      const task = teamManager.createTask(
        resolvedTeamId,
        `${teammateDisplayName} task`,
        params.prompt,
        parent.id,
        {
          requirementIds,
          driOwner: parsedSpec.ownerDRI,
          assignee: teammateSession.id,
        }
      )
      // Implements REQ-002: bind task to teammate + mark in progress
      teamManager.updateTaskStatus(resolvedTeamId, task.id, 'in_progress', teammateSession.id)
    }

    const teammatePrompt = buildTeammatePromptWithCompactSpec(params.prompt, compactSpecContext)

    // Kick off the teammate by sending the prompt
    // Use setTimeout to avoid blocking the caller, but track timer so cleanup can cancel it.
    const kickoffTimer = setTimeout(async () => {
      this.teammateKickoffTimers.delete(teammateSession.id)
      try {
        await this.sendMessage(teammateSession.id, teammatePrompt)
      } catch (err) {
        sessionLog.error(`Failed to start teammate ${teammateDisplayName}:`, err)
      }
    }, 100)
    this.teammateKickoffTimers.set(teammateSession.id, kickoffTimer)

    return teammateSession
  }

  /**
   * Clean up an agent team — interrupt all running teammates and clear team state.
   */
  async cleanupTeam(leadSessionId: string): Promise<void> {
    const lead = this.sessions.get(leadSessionId)
    if (!lead || !lead.teammateSessionIds) return

    sessionLog.info(`[AgentTeams] Cleaning up team for lead session ${leadSessionId}, ${lead.teammateSessionIds.length} teammates`)
    const resolvedTeamId = lead.teamId ? teamManager.resolveTeamId(lead.teamId) : undefined

    // Interrupt all running teammate sessions
    for (const teammateId of lead.teammateSessionIds) {
      await this.terminateTeammateSession(teammateId, 'cleanupTeam')
    }

    // Stop health monitoring for this team
    if (resolvedTeamId) {
      this.stopTeamHealthMonitoring(resolvedTeamId)
      await teamManager.cleanupTeam(resolvedTeamId)
    }

    // Clear team state on lead
    lead.teamId = undefined
    lead.isTeamLead = undefined
    lead.teammateSessionIds = undefined
    lead.teamColor = undefined
    this.persistSession(lead)
  }

  /**
   * Create a sub-session under a parent session.
   * Sub-sessions inherit workspace config but have a reference to their parent.
   */
  async createSubSession(workspaceId: string, parentSessionId: string, options?: import('../shared/types').CreateSessionOptions): Promise<Session> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    const workspaceRootPath = workspace.rootPath

    // Create the sub-session using storage layer (validates parent exists and prevents nesting)
    const storedSession = await createStoredSubSession(workspaceRootPath, parentSessionId, {
      name: options?.name,
      workingDirectory: options?.workingDirectory,
      permissionMode: options?.permissionMode,
      enabledSourceSlugs: options?.enabledSourceSlugs,
      model: options?.model,
      todoState: options?.todoState,
      labels: options?.labels,
    })

    // Get workspace defaults for managed session
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const globalDefaults = loadConfigDefaults()
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode
    const defaultThinkingLevel = wsConfig?.defaults?.thinkingLevel ?? globalDefaults.workspaceDefaults.thinkingLevel
    const defaultSddEnabled = options?.sddEnabled ?? wsConfig?.sdd?.sddEnabled ?? false
    const defaultSpecId = options?.activeSpecId

    const managed: ManagedSession = {
      id: storedSession.id,
      workspace,
      agent: null,
      messages: [],
      isProcessing: false,
      lastMessageAt: storedSession.lastMessageAt ?? storedSession.lastUsedAt,
      streamingText: '',
      processingGeneration: 0,
      isFlagged: options?.isFlagged ?? false,
      todoState: options?.todoState,
      labels: options?.labels,
      permissionMode: defaultPermissionMode,
      workingDirectory: storedSession.workingDirectory,
      sdkCwd: storedSession.sdkCwd,
      model: options?.model || storedSession.model,
      llmProvider: storedSession.llmProvider ?? inferProviderFromModel(options?.model || storedSession.model),
      thinkingLevel: defaultThinkingLevel,
      messageQueue: [],
      backgroundShellCommands: new Map(),
      messagesLoaded: true,
      parentSessionId,
      sddEnabled: defaultSddEnabled,
      activeSpecId: defaultSpecId,
      sddComplianceReports: [],
      // Initialize TokenRefreshManager for this session
      tokenRefreshManager: new TokenRefreshManager(getSourceCredentialManager(), {
        log: (msg) => sessionLog.debug(msg),
      }),
    }

    this.sessions.set(storedSession.id, managed)
    this.persistSession(managed)

    if (defaultSddEnabled && !defaultSpecId) {
      await this.ensureSessionActiveSpec(storedSession.id)
    }

    // Notify all windows that a sub-session was created (for session list updates)
    this.sendEvent({
      type: 'session_created',
      sessionId: storedSession.id,
      parentSessionId,
    }, workspace.id)

    return {
      id: storedSession.id,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      lastMessageAt: managed.lastMessageAt,
      messages: [],
      isProcessing: false,
      isFlagged: options?.isFlagged ?? false,
      permissionMode: defaultPermissionMode,
      todoState: options?.todoState,
      labels: options?.labels,
      workingDirectory: storedSession.workingDirectory,
      model: managed.model,
      llmProvider: managed.llmProvider,
      thinkingLevel: defaultThinkingLevel,
      sessionFolderPath: getSessionStoragePath(workspaceRootPath, storedSession.id),
      parentSessionId,
      sddEnabled: defaultSddEnabled,
      activeSpecId: managed.activeSpecId,
      sddComplianceReports: [],
    }
  }

  /**
   * Get session family (parent + siblings) for a sub-session.
   * Returns null if the session is a root session (no parent).
   */
  getSessionFamily(sessionId: string): import('../shared/types').SessionFamily | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null

    return getStoredSessionFamily(managed.workspace.rootPath, sessionId)
  }

  /**
   * Update sibling order for multiple sessions.
   * Used when user reorders siblings via drag-drop.
   */
  async updateSiblingOrder(orderedSessionIds: string[]): Promise<void> {
    if (orderedSessionIds.length === 0) return

    // Get workspace from first session
    const firstSession = this.sessions.get(orderedSessionIds[0]!)
    if (!firstSession) return

    await updateStoredSiblingOrder(firstSession.workspace.rootPath, orderedSessionIds)

    // Notify all windows for session list refresh
    this.sendEvent({ type: 'sessions_reordered' }, firstSession.workspace.id)
  }

  /**
   * Archive a session and all its children.
   * Returns the count of sessions archived.
   */
  async archiveSessionCascade(sessionId: string): Promise<{ count: number }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { count: 0 }

    // Get children before archiving
    const children = getStoredChildSessions(managed.workspace.rootPath, sessionId)

    // Archive via storage layer
    const count = await archiveStoredSessionCascade(managed.workspace.rootPath, sessionId)

    // Update in-memory state for parent
    managed.isArchived = true
    managed.archivedAt = Date.now()

    // Update in-memory state for children
    for (const child of children) {
      const childManaged = this.sessions.get(child.id)
      if (childManaged) {
        childManaged.isArchived = true
        childManaged.archivedAt = Date.now()
      }
    }

    // Notify all windows
    this.sendEvent({ type: 'session_archived_cascade', sessionId, count }, managed.workspace.id)

    return { count }
  }

  /**
   * Delete a session and all its children.
   * Returns the count of sessions deleted.
   */
  deleteSessionCascade(sessionId: string): { count: number } {
    const managed = this.sessions.get(sessionId)
    if (!managed) return { count: 0 }

    // Get children before deleting
    const children = getStoredChildSessions(managed.workspace.rootPath, sessionId)

    // Delete via storage layer
    const count = deleteStoredSessionCascade(managed.workspace.rootPath, sessionId)

    // Remove from in-memory state
    this.sessions.delete(sessionId)
    for (const child of children) {
      this.sessions.delete(child.id)
    }

    // Notify all windows
    this.sendEvent({ type: 'session_deleted_cascade', sessionId, count }, managed.workspace.id)

    return { count }
  }

  /**
   * Get or create agent for a session (lazy loading)
   * Creates CraftAgent for Claude or CodexBackend for Codex based on LLM connection.
   *
   * Provider resolution order:
   * 1. session.llmConnection (locked after first message)
   * 2. workspace.defaults.defaultLlmConnection
   * 3. global defaultLlmConnection
   * 4. fallback: no connection configured
   */
  private async getOrCreateAgent(managed: ManagedSession): Promise<AgentInstance> {
    if (!managed.agent) {
      const end = perf.start('agent.create', { sessionId: managed.id })
      const config = loadStoredConfig()

      // Enable agent teams env var if workspace has it enabled
      // This sets CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 in the SDK subprocess environment,
      // which exposes team-related tools (spawn teammate, message, broadcast, task management)
      const teamsEnabled = isAgentTeamsEnabled(managed.workspace.rootPath)
      setAgentTeamsEnvFlag(teamsEnabled)
      if (teamsEnabled) {
        sessionLog.info(`Agent teams enabled for workspace ${managed.workspace.id}`)
      }

      // Resolve LLM connection for this session
      const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const connection = resolveSessionConnection(
        managed.llmConnection,
        workspaceConfig?.defaults?.defaultLlmConnection
      )

      // Lock the connection after first resolution
      // This ensures the session always uses the same provider
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection.slug
        managed.connectionLocked = true
        sessionLog.info(`Locked session ${managed.id} to connection "${connection.slug}"`)
        this.persistSession(managed)
      }

      // Determine provider from connection or fall back to legacy authType
      let provider: 'anthropic' | 'openai' | 'copilot'
      let authType: LlmAuthType | undefined

      if (connection) {
        provider = providerTypeToAgentProvider(connection.providerType || 'anthropic')
        authType = connectionAuthTypeToBackendAuthType(connection.authType)
        managed.llmProvider = resolveUsageProvider(connection.providerType, managed.model || connection.defaultModel)
        sessionLog.info(`Using LLM connection "${connection.slug}" (${connection.providerType}) for session ${managed.id}`)
      } else {
        // Fallback: try to get default connection
        const defaultConnSlug = getDefaultLlmConnection()
        const defaultConn = defaultConnSlug ? getLlmConnection(defaultConnSlug) : null
        if (defaultConn) {
          provider = providerTypeToAgentProvider(defaultConn.providerType || 'anthropic')
          authType = connectionAuthTypeToBackendAuthType(defaultConn.authType)
          managed.llmProvider = resolveUsageProvider(defaultConn.providerType, managed.model || defaultConn.defaultModel)
          sessionLog.info(`Using default LLM connection "${defaultConn.slug}" (${defaultConn.providerType}) for session ${managed.id}`)
        } else {
          // No connections at all - fall back to anthropic provider
          provider = 'anthropic'
          authType = undefined
          managed.llmProvider = inferProviderFromModel(managed.model)
          sessionLog.warn(`No LLM connection found for session ${managed.id}, using default anthropic provider`)
        }
      }

      // Set session directory for tool metadata cross-process sharing.
      // The SDK subprocess reads CRAFT_SESSION_DIR to write tool-metadata.json;
      // the main process reads it via toolMetadataStore.setSessionDir().
      const sessionDirForMetadata = getSessionStoragePath(managed.workspace.rootPath, managed.id)
      process.env.CRAFT_SESSION_DIR = sessionDirForMetadata
      toolMetadataStore.setSessionDir(sessionDirForMetadata)

      // Set up agentReady promise so title generation can await agent creation
      managed.agentReady = new Promise<void>(r => { managed.agentReadyResolve = r })

      // Create the appropriate backend based on provider
      if (provider === 'openai') {
        // Codex backend - uses app-server protocol
        // Model from session > connection default (connection always has defaultModel via backfill)
        // Safety: ensure the resolved model is actually a Codex model (not a Claude model from stale session data)
        const rawCodexModel = managed.model || connection?.defaultModel
        const codexModel = (rawCodexModel && isCodexModel(rawCodexModel)) ? rawCodexModel : (connection?.defaultModel || DEFAULT_CODEX_MODEL)

        // Set up per-session Codex configuration (MCP servers, etc.)
        // This creates .codex-home/config.toml in the session folder
        const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
        const enabledSlugs = managed.enabledSourceSlugs || []
        const allSources = loadAllSources(managed.workspace.rootPath)
        const enabledSources = allSources.filter(s =>
          enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
        )
        const { mcpServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)
        const codexHome = await setupCodexSessionConfig(sessionPath, enabledSources, mcpServers, managed.id, managed.workspace.rootPath)

        managed.agent = new CodexBackend({
          provider: 'openai',
          authType: authType || 'oauth',
          workspace: managed.workspace,
          model: codexModel,
          miniModel: connection ? getMiniModel(connection) : undefined,
          thinkingLevel: managed.thinkingLevel,
          codexHome, // Per-session config directory
          session: {
            id: managed.id,
            workspaceRootPath: managed.workspace.rootPath,
            sdkSessionId: managed.sdkSessionId,
            createdAt: managed.lastMessageAt,
            lastUsedAt: managed.lastMessageAt,
            workingDirectory: managed.workingDirectory,
            sdkCwd: managed.sdkCwd,
            model: managed.model,
            llmProvider: managed.llmProvider,
            llmConnection: managed.llmConnection,
            // SDD: pass spec-driven development state to prompt builder
            sddEnabled: managed.sddEnabled,
            activeSpecId: managed.activeSpecId,
          },
          // Agent teams: callback to spawn teammates as separate sessions (Codex lead parity)
          onTeammateSpawnRequested: teamsEnabled ? async (params) => {
            sessionLog.info(`[AgentTeams] (Codex) Teammate spawn requested: ${params.teammateName} for team "${params.teamName}"`)
            const teammateSession = await this.createTeammateSession({
              parentSessionId: managed.id,
              workspaceId: managed.workspace.id,
              teamId: params.teamName,
              teammateName: params.teammateName,
              prompt: params.prompt,
              model: params.model,
              role: (params.role as TeamRole | undefined) ?? 'worker',
            })
            return { sessionId: teammateSession.id, agentId: teammateSession.id }
          } : undefined,
          // Agent teams: callback to route messages between teammate sessions (Codex lead parity)
          onTeammateMessage: teamsEnabled ? async (params) => {
            const teammateIds = managed.teammateSessionIds || []
            sessionLog.info(`[AgentTeams] (Codex) Message routing: type=${params.type}, target=${params.targetName}, teammates=${teammateIds.length}`)

            if (params.type === 'broadcast') {
              let delivered = 0
              for (const tid of teammateIds) {
                const teammate = this.sessions.get(tid)
                if (teammate) {
                  try {
                    await this.sendMessage(tid, `[From Lead] ${params.content}`)
                    delivered++
                  } catch (err) {
                    sessionLog.error(`[AgentTeams] (Codex) Failed to broadcast to ${tid}:`, err)
                  }
                }
              }
              return { delivered: delivered > 0, error: delivered === 0 ? 'No teammates found' : undefined }
            }

            for (const tid of teammateIds) {
              const teammate = this.sessions.get(tid)
              if (teammateMatchesTargetName(teammate?.teammateName, teammate?.name, params.targetName)) {
                if (params.type === 'shutdown_request') {
                  const terminated = await this.terminateTeammateSession(tid, 'shutdown_request')
                  return terminated ? { delivered: true } : { delivered: false, error: `Teammate "${params.targetName}" not found` }
                }
                try {
                  await this.sendMessage(tid, `[From Lead] ${params.content}`)
                  return { delivered: true }
                } catch (err) {
                  return { delivered: false, error: String(err) }
                }
              }
            }
            return { delivered: false, error: `Teammate "${params.targetName}" not found` }
          } : undefined,
          // Critical: Immediately persist SDK session ID when captured to prevent loss on crash.
          onSdkSessionIdUpdate: (sdkSessionId: string) => {
            managed.sdkSessionId = sdkSessionId
            sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          // Called when SDK session ID is cleared after failed resume (thread not found)
          onSdkSessionIdCleared: () => {
            managed.sdkSessionId = undefined
            sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          // Called to get recent messages for recovery context when resume fails.
          // Returns last 6 messages (3 exchanges) of user/assistant content.
          getRecoveryMessages: () => {
            const relevantMessages = managed.messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .filter(m => !m.isIntermediate)  // Skip intermediate assistant messages
              .slice(-6);  // Last 6 messages (3 exchanges)

            return relevantMessages.map(m => ({
              type: m.role as 'user' | 'assistant',
              content: m.content,
            }));
          },
        })
        sessionLog.info(`Created Codex agent for session ${managed.id} (model: ${codexModel}, codexHome: ${codexHome})${managed.sdkSessionId ? ' (resuming)' : ''}`)

        // Wire up onDebug so Codex/AppServerClient debug messages appear in logs
        // (BaseAgent.onDebug defaults to null, so without this all debug output is lost)
        managed.agent.onDebug = (msg: string) => {
          // Suppress ultra-noisy Codex delta spam to avoid log amplification/OOM
          const isNoisyCodexLog =
            msg.includes('[AppServer]') &&
            (msg.includes('item/started') ||
              msg.includes('item/completed') ||
              msg.includes('item/commandExecution/outputDelta') ||
              msg.includes('item/agentMessage/delta') ||
              msg.includes('item/reasoning/textDelta') ||
              msg.includes('item/reasoning/summaryTextDelta') ||
              msg.includes('item/reasoning/summaryPartAdded') ||
              msg.includes('thread/tokenUsage/updated') ||
              msg.includes('account/rateLimits/updated') ||
              msg.includes('codex/event/') ||
              msg.includes('Unknown notification: codex/event/') ||
              msg.includes('Unknown notification: item/reasoning/summaryTextDelta') ||
              msg.includes('Unknown notification: item/reasoning/summaryPartAdded') ||
              msg.includes('Unknown notification: account/rateLimits/updated'));

          if (isNoisyCodexLog) return;

          sessionLog.info(`[CodexDebug:${managed.id}] ${msg}`)
        }

        // CRITICAL: Inject stored credentials into Codex app-server
        // Without this, the app-server spawns but has no authentication, causing silent failures
        const codexAgent = managed.agent as CodexAgent
        codexAgent.onDebug = (msg: string) => sessionLog.info(msg)
        const codexAuthType = connection?.authType || authType

        // Determine auth method based on connection authType
        // - 'oauth' → ChatGPT Plus OAuth tokens
        // - 'api_key' or 'api_key_with_endpoint' → OpenAI API key
        const useApiKey = codexAuthType === 'api_key' || codexAuthType === 'api_key_with_endpoint'

        if (useApiKey) {
          // Inject stored API key (OpenAI Platform, OpenRouter, Vercel AI Gateway)
          const apiKeyInjected = await codexAgent.tryInjectStoredApiKey()
          if (apiKeyInjected) {
            sessionLog.info(`OpenAI API key injected for Codex session ${managed.id}`)
          } else {
            sessionLog.warn(`No OpenAI API key available for Codex session ${managed.id} - user may need to configure API key`)
            // Surface immediately so user doesn't wait 30s for a timeout
            this.sendEvent({
              type: 'info',
              sessionId: managed.id,
              message: 'No OpenAI API key available. Please configure your API key in Settings → AI.',
              level: 'error',
            }, managed.workspace.id)
          }
        } else {
          // Wire up auth callback to notify UI when re-authentication is needed (OAuth only)
          // Uses 'info' event with 'error' level to display a warning to the user
          codexAgent.onChatGptAuthRequired = (reason: string) => {
            sessionLog.warn(`ChatGPT auth required for session ${managed.id}: ${reason}`)
            this.sendEvent({
              type: 'info',
              sessionId: managed.id,
              message: `ChatGPT authentication required: ${reason}. Please check your Codex login.`,
              level: 'error',
            })
          }

          // Inject stored OAuth tokens (if available) - this is async but we await it
          sessionLog.info(`[Codex:${managed.id}] Calling tryInjectStoredChatGptTokens (this spawns codex app-server)...`)
          const tokensInjected = await codexAgent.tryInjectStoredChatGptTokens()
          if (tokensInjected) {
            sessionLog.info(`ChatGPT tokens injected for Codex session ${managed.id}`)
          } else {
            sessionLog.warn(`No ChatGPT tokens available for Codex session ${managed.id} - user may need to authenticate`)
            // Surface immediately so user doesn't wait 30s for a timeout
            this.sendEvent({
              type: 'info',
              sessionId: managed.id,
              message: 'No ChatGPT tokens available. Please check your Codex login in Settings → AI.',
              level: 'error',
            }, managed.workspace.id)
          }
          sessionLog.info(`[Codex:${managed.id}] Token injection complete, proceeding to chat`)
        }
      } else if (provider === 'copilot') {
        // Copilot backend - uses @github/copilot-sdk

        const rawCopilotModel = managed.model || connection?.defaultModel!
        const copilotModel = rawCopilotModel || 'gpt-5'

        // Load sources for MCP config
        const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
        const enabledSlugs = managed.enabledSourceSlugs || []
        const allSources = loadAllSources(managed.workspace.rootPath)
        const enabledSources = allSources.filter(s =>
          enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
        )
        const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager)

        // Session MCP server path - provides session-scoped tools (SubmitPlan, config_validate, etc.)
        // Same resolution logic as Codex branch (line ~324)
        const copilotSessionServerPath = app.isPackaged
          ? join(app.getAppPath(), 'resources', 'session-mcp-server', 'index.js')
          : join(process.cwd(), 'packages', 'session-mcp-server', 'dist', 'index.js')
        const copilotSessionServerExists = existsSync(copilotSessionServerPath)
        if (!copilotSessionServerExists) {
          sessionLog.warn(`Session MCP server not found at ${copilotSessionServerPath}. Session-scoped tools (SubmitPlan, etc.) will not be available in Copilot sessions. Run 'bun run electron:build' to build it.`)
        }

        // Create per-session config directory for Copilot CLI
        const copilotConfigDir = join(sessionPath, '.copilot-config')
        await mkdir(copilotConfigDir, { recursive: true })

        // Bridge MCP server path for API sources (same binary as Codex)
        const bridgeServer = resolveBridgeServerPath()
        if (!bridgeServer.exists) {
          sessionLog.warn(`Bridge MCP server not found at ${bridgeServer.path}. API sources will not be available in Copilot sessions.`)
        }

        managed.agent = new CopilotAgent({
          provider: 'copilot',
          authType: authType || 'oauth',
          workspace: managed.workspace,
          model: copilotModel,
          miniModel: connection ? getMiniModel(connection) : undefined,
          thinkingLevel: managed.thinkingLevel,
          connectionSlug: connection?.slug,
          copilotCliPath: this.copilotCliPath,
          copilotInterceptorPath: this.copilotInterceptorPath,
          copilotConfigDir,
          sessionServerPath: copilotSessionServerExists ? copilotSessionServerPath : undefined,
          bridgeServerPath: bridgeServer.exists ? bridgeServer.path : undefined,
          nodePath: getBundledBunPath() ?? 'bun',
          session: {
            id: managed.id,
            workspaceRootPath: managed.workspace.rootPath,
            sdkSessionId: managed.sdkSessionId,
            createdAt: managed.lastMessageAt,
            lastUsedAt: managed.lastMessageAt,
            workingDirectory: managed.workingDirectory,
            sdkCwd: managed.sdkCwd,
            model: managed.model,
            llmConnection: managed.llmConnection,
          },
          onSdkSessionIdUpdate: (sdkSessionId: string) => {
            managed.sdkSessionId = sdkSessionId
            sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          onSdkSessionIdCleared: () => {
            managed.sdkSessionId = undefined
            sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          getRecoveryMessages: () => {
            const relevantMessages = managed.messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .filter(m => !m.isIntermediate)
              .slice(-6)
            return relevantMessages.map(m => ({
              type: m.role as 'user' | 'assistant',
              content: m.content,
            }))
          },
        })
        sessionLog.info(`Created Copilot agent for session ${managed.id} (model: ${copilotModel})${managed.sdkSessionId ? ' (resuming)' : ''}`)

        // Wire up auth callback and inject stored tokens
        const copilotAgent = managed.agent as CopilotAgent
        copilotAgent.onGithubAuthRequired = (reason: string) => {
          sessionLog.warn(`GitHub auth required for session ${managed.id}: ${reason}`)
          this.sendEvent({
            type: 'info',
            sessionId: managed.id,
            message: `GitHub authentication required: ${reason}. Please check your Copilot login.`,
            level: 'error',
          })
        }

        const tokensInjected = await copilotAgent.tryInjectStoredGithubToken()
        if (tokensInjected) {
          sessionLog.info(`GitHub token injected for Copilot session ${managed.id}`)
        } else {
          sessionLog.warn(`No GitHub token available for Copilot session ${managed.id} - user may need to authenticate`)
        }

        // Set source servers (includes both MCP and API sources)
        if (Object.keys(mcpServers).length > 0 || Object.keys(apiServers).length > 0) {
          // Write bridge config for API sources before setting servers
          await setupCopilotBridgeConfig(copilotConfigDir, enabledSources)
          copilotAgent.setSourceServers(mcpServers, apiServers, enabledSlugs)
        }
      } else {
        // Claude backend - uses Anthropic SDK
        // CRITICAL: Set env vars for this session's connection BEFORE creating the agent.
        // The SDK subprocess inherits env vars at spawn time, so we must ensure
        // ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_BASE_URL
        // are set for the correct connection, not whatever was last initialized.
        if (connection) {
          await this.reinitializeAuth(connection.slug)
        }

        // Model resolution: session > connection default (connection always has defaultModel via backfill)
        const resolvedModel = managed.model || connection?.defaultModel || DEFAULT_MODEL
        managed.agent = new CraftAgent({
          workspace: managed.workspace,
          model: resolvedModel,
          // Initialize thinking level at construction to avoid race conditions
          thinkingLevel: managed.thinkingLevel,
          isHeadless: !AGENT_FLAGS.defaultModesEnabled,
          // Pass the workspace-level HookSystem so agents reuse the shared instance
          hookSystem: this.hookSystems.get(managed.workspace.rootPath),
          // System prompt preset for mini agents (focused prompts for quick edits)
          systemPromptPreset: managed.systemPromptPreset,
          // Always pass session object - id is required for plan mode callbacks
          // sdkSessionId is optional and used for conversation resumption
          session: {
            id: managed.id,
            workspaceRootPath: managed.workspace.rootPath,
            sdkSessionId: managed.sdkSessionId,
            createdAt: managed.lastMessageAt,
            lastUsedAt: managed.lastMessageAt,
            workingDirectory: managed.workingDirectory,
            sdkCwd: managed.sdkCwd,
            model: managed.model,
            llmProvider: managed.llmProvider,
            llmConnection: managed.llmConnection,
            // SDD: pass spec-driven development state to prompt builder
            sddEnabled: managed.sddEnabled,
            activeSpecId: managed.activeSpecId,
          },
          // Critical: Immediately persist SDK session ID when captured to prevent loss on crash.
          // Without this, the ID is only saved via debounced persistSession() which may not
          // complete before app crash/quit, causing session resumption to fail.
          onSdkSessionIdUpdate: (sdkSessionId: string) => {
            managed.sdkSessionId = sdkSessionId
            sessionLog.info(`SDK session ID captured for ${managed.id}: ${sdkSessionId}`)
            // Persist immediately and flush - critical for resumption reliability
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          // Called when SDK session ID is cleared after failed resume (empty response recovery)
          onSdkSessionIdCleared: () => {
            managed.sdkSessionId = undefined
            sessionLog.info(`SDK session ID cleared for ${managed.id} (resume recovery)`)
            // Persist immediately to prevent repeated resume attempts
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          },
          // Called to get recent messages for recovery context when resume fails.
          // Returns last 6 messages (3 exchanges) of user/assistant content.
          getRecoveryMessages: () => {
            const relevantMessages = managed.messages
              .filter(m => m.role === 'user' || m.role === 'assistant')
              .filter(m => !m.isIntermediate)  // Skip intermediate assistant messages
              .slice(-6);  // Last 6 messages (3 exchanges)

            return relevantMessages.map(m => ({
              type: m.role as 'user' | 'assistant',
              content: m.content,
            }));
          },
          // Debug mode - enables log file path injection into system prompt
          debugMode: isDebugMode ? {
            enabled: true,
            logFilePath: getLogFilePath(),
          } : undefined,
          // Agent teams: callback to spawn teammates as separate sessions
          onTeammateSpawnRequested: teamsEnabled ? async (params) => {
            sessionLog.info(`[AgentTeams] Teammate spawn requested: ${params.teammateName} for team "${params.teamName}"`)
            const teammateSession = await this.createTeammateSession({
              parentSessionId: managed.id,
              workspaceId: managed.workspace.id,
              teamId: params.teamName,
              teammateName: params.teammateName,
              prompt: params.prompt,
              model: params.model,
              role: (params.role as TeamRole | undefined) ?? 'worker',
            })
            return { sessionId: teammateSession.id, agentId: teammateSession.id }
          } : undefined,
          // Agent teams: callback to route messages between teammate sessions
          onTeammateMessage: teamsEnabled ? async (params) => {
            const teammateIds = managed.teammateSessionIds || []
            sessionLog.info(`[AgentTeams] Message routing: type=${params.type}, target=${params.targetName}, teammates=${teammateIds.length}`)

            if (params.type === 'broadcast') {
              // Send to all teammates
              let delivered = 0
              for (const tid of teammateIds) {
                const teammate = this.sessions.get(tid)
                if (teammate) {
                  try {
                    await this.sendMessage(tid, `[From Lead] ${params.content}`)
                    delivered++
                  } catch (err) {
                    sessionLog.error(`[AgentTeams] Failed to broadcast to ${tid}:`, err)
                  }
                }
              }
              return { delivered: delivered > 0, error: delivered === 0 ? 'No teammates found' : undefined }
            }

            // Direct message: find teammate by name
            for (const tid of teammateIds) {
              const teammate = this.sessions.get(tid)
              if (teammateMatchesTargetName(teammate?.teammateName, teammate?.name, params.targetName)) {
                if (params.type === 'shutdown_request') {
                  const terminated = await this.terminateTeammateSession(tid, 'shutdown_request')
                  return terminated ? { delivered: true } : { delivered: false, error: `Teammate "${params.targetName}" not found` }
                }
                // Regular message
                try {
                  await this.sendMessage(tid, `[From Lead] ${params.content}`)
                  return { delivered: true }
                } catch (err) {
                  return { delivered: false, error: String(err) }
                }
              }
            }
            return { delivered: false, error: `Teammate "${params.targetName}" not found` }
          } : undefined,
        })
        sessionLog.info(`Created Claude agent for session ${managed.id}${managed.sdkSessionId ? ' (resuming)' : ''}`)
      }

      // Signal that the agent instance is ready (unblocks title generation)
      managed.agentReadyResolve?.()

      // Set up permission handler to forward requests to renderer
      managed.agent.onPermissionRequest = (request: { requestId: string; toolName: string; command?: string; description: string; type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' }) => {
        sessionLog.info(`Permission request for session ${managed.id}:`, request.command)
        this.sendEvent({
          type: 'permission_request',
          sessionId: managed.id,
          request: {
            ...request,
            sessionId: managed.id,
          }
        }, managed.workspace.id)
      }

      // Note: Credential requests now flow through onAuthRequest (unified auth flow)
      // The legacy onCredentialRequest callback has been removed from CraftAgent
      // Auth refresh for mid-session token expiry is handled by the error handler in sendMessage
      // which destroys/recreates the agent to get fresh credentials

      // Set up mode change handlers
      managed.agent.onPermissionModeChange = (mode) => {
        sessionLog.info(`Permission mode changed for session ${managed.id}:`, mode)
        managed.permissionMode = mode
        this.sendEvent({
          type: 'permission_mode_changed',
          sessionId: managed.id,
          permissionMode: managed.permissionMode,
        }, managed.workspace.id)
      }

      // Wire up onPlanSubmitted to add plan message to conversation
      managed.agent.onPlanSubmitted = async (planPath) => {
        sessionLog.info(`Plan submitted for session ${managed.id}:`, planPath)
        try {
          if (managed.sddEnabled && !managed.activeSpecId) {
            await this.ensureSessionActiveSpec(managed.id)
          }
          if (managed.sddEnabled) {
            await this.syncSessionComplianceReportsFromStorage(managed.id)
          }
          // Read the plan file content
          const planContent = await readFile(planPath, 'utf-8')

          if (managed.sddEnabled && managed.activeSpecId) {
            const interimReport = this.generateSpecComplianceReport(managed)
            if (interimReport) {
              const existingReports = managed.sddComplianceReports ?? []
              managed.sddComplianceReports = [...existingReports, interimReport]
              this.persistSession(managed)
              this.sendEvent({
                type: 'sdd_compliance_report',
                sessionId: managed.id,
                report: interimReport,
              }, managed.workspace.id)
            }
          }

          // Mark the SubmitPlan tool message as completed (it won't get a tool_result due to forceAbort)
          const submitPlanMsg = managed.messages.find(
            m => m.toolName?.includes('SubmitPlan') && m.toolStatus === 'executing'
          )
          if (submitPlanMsg && submitPlanMsg.toolStatus !== 'error') {
            submitPlanMsg.toolStatus = 'completed'
            submitPlanMsg.content = 'Plan submitted for review'
            submitPlanMsg.toolResult = 'Plan submitted for review'
          }

          // Create a plan message
          const planMessage = {
            id: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            role: 'plan' as const,
            content: planContent,
            timestamp: this.monotonic(),
            planPath,
          }

          // Add to session messages
          managed.messages.push(planMessage)

          // Update lastMessageRole for badge display
          managed.lastMessageRole = 'plan'

          // Send event to renderer
          this.sendEvent({
            type: 'plan_submitted',
            sessionId: managed.id,
            message: planMessage,
          }, managed.workspace.id)

          // Force-abort execution - plan presentation is a stopping point
          // The user needs to review and respond before continuing
          if (managed.isProcessing && managed.agent) {
            sessionLog.info(`Force-aborting after plan submission for session ${managed.id}`)
            managed.agent.forceAbort(AbortReason.PlanSubmitted)
            managed.isProcessing = false

            // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
            this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage }, managed.workspace.id)

            // Persist session state
            this.persistSession(managed)
          }
        } catch (error) {
          sessionLog.error(`Failed to read plan file:`, error)
        }
      }

      // Wire up onAuthRequest to add auth message to conversation and pause execution
      managed.agent.onAuthRequest = (request) => {
        sessionLog.info(`Auth request for session ${managed.id}:`, request.type, request.sourceSlug)

        // Create auth-request message
        const authMessage: Message = {
          id: generateMessageId(),
          role: 'auth-request',
          content: this.getAuthRequestDescription(request),
          timestamp: this.monotonic(),
          authRequestId: request.requestId,
          authRequestType: request.type,
          authSourceSlug: request.sourceSlug,
          authSourceName: request.sourceName,
          authStatus: 'pending',
          // Copy type-specific fields for credentials
          ...(request.type === 'credential' && {
            authCredentialMode: request.mode,
            authLabels: request.labels,
            authDescription: request.description,
            authHint: request.hint,
            authHeaderName: request.headerName,
            authHeaderNames: request.headerNames,
            authSourceUrl: request.sourceUrl,
            authPasswordRequired: request.passwordRequired,
          }),
        }

        // Add to session messages
        managed.messages.push(authMessage)

        // Store pending auth request for later resolution
        managed.pendingAuthRequestId = request.requestId
        managed.pendingAuthRequest = request

        // Force-abort execution (like SubmitPlan)
        if (managed.isProcessing && managed.agent) {
          sessionLog.info(`Force-aborting after auth request for session ${managed.id}`)
          managed.agent.forceAbort(AbortReason.AuthRequest)
          managed.isProcessing = false

          // Send complete event so renderer knows processing stopped (include tokenUsage for real-time updates)
          this.sendEvent({ type: 'complete', sessionId: managed.id, tokenUsage: managed.tokenUsage }, managed.workspace.id)
        }

        // Emit auth_request event to renderer
        this.sendEvent({
          type: 'auth_request',
          sessionId: managed.id,
          message: authMessage,
          request: request,
        }, managed.workspace.id)

        // Persist session state
        this.persistSession(managed)

        // OAuth flow is now user-initiated via startSessionOAuth()
        // The UI will call sessionCommand({ type: 'startOAuth' }) when user clicks "Sign in"
      }

      // Wire up onSourceActivationRequest to auto-enable sources when agent tries to use them
      managed.agent.onSourceActivationRequest = async (sourceSlug: string): Promise<boolean> => {
        sessionLog.info(`Source activation request for session ${managed.id}:`, sourceSlug)

        const workspaceRootPath = managed.workspace.rootPath

        // Check if source is already enabled
        if (managed.enabledSourceSlugs?.includes(sourceSlug)) {
          sessionLog.info(`Source ${sourceSlug} already in enabledSourceSlugs, checking server status`)
          // Source is in the list but server might not be active (e.g., build failed previously)
        }

        // Load the source to check if it exists and is ready
        const sources = getSourcesBySlugs(workspaceRootPath, [sourceSlug])
        if (sources.length === 0) {
          sessionLog.warn(`Source ${sourceSlug} not found in workspace`)
          return false
        }

        const source = sources[0]

        // Check if source is usable (enabled and authenticated if auth is required)
        if (!isSourceUsable(source)) {
          sessionLog.warn(`Source ${sourceSlug} is not usable (disabled or requires authentication)`)
          return false
        }

        // Track whether we added this slug (for rollback on failure)
        const slugSet = new Set(managed.enabledSourceSlugs || [])
        const wasAlreadyEnabled = slugSet.has(sourceSlug)

        // Add to enabled sources if not already there
        if (!wasAlreadyEnabled) {
          slugSet.add(sourceSlug)
          managed.enabledSourceSlugs = Array.from(slugSet)
          sessionLog.info(`Added source ${sourceSlug} to session enabled sources`)
        }

        // Build server configs for all enabled sources
        const allEnabledSources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs || [])
        // Pass session path so large API responses can be saved to session folder
        const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
        const { mcpServers, apiServers, errors } = await buildServersFromSources(allEnabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())

        if (errors.length > 0) {
          sessionLog.warn(`Source build errors during auto-enable:`, errors)
        }

        // Check if our target source was built successfully
        const sourceBuilt = sourceSlug in mcpServers || sourceSlug in apiServers
        if (!sourceBuilt) {
          sessionLog.warn(`Source ${sourceSlug} failed to build`)
          // Only remove if WE added it (not if it was already there)
          if (!wasAlreadyEnabled) {
            slugSet.delete(sourceSlug)
            managed.enabledSourceSlugs = Array.from(slugSet)
          }
          return false
        }

        // Apply source servers to the agent
        const intendedSlugs = allEnabledSources
          .filter(isSourceUsable)
          .map(s => s.config.slug)

        // For Codex backend, regenerate config.toml and reconnect to pick up new sources
        // (Codex reads MCP config from file at startup, unlike Claude which has runtime injection)
        if (managed.agent instanceof CodexBackend) {
          await setupCodexSessionConfig(
            sessionPath,
            allEnabledSources,
            mcpServers,
            managed.id,
            workspaceRootPath
          )
          await managed.agent.reconnect()
          sessionLog.info(`Codex config regenerated and reconnected for source enable in session ${managed.id}`)
        }

        // For Copilot backend, write bridge config for API sources
        if (managed.agent instanceof CopilotAgent) {
          const copilotConfigDir = join(sessionPath, '.copilot-config')
          await setupCopilotBridgeConfig(copilotConfigDir, allEnabledSources)
        }

        managed.agent!.setSourceServers(mcpServers, apiServers, intendedSlugs)

        sessionLog.info(`Auto-enabled source ${sourceSlug} for session ${managed.id}`)

        // Persist session with updated enabled sources
        this.persistSession(managed)

        // Notify renderer of source change
        this.sendEvent({
          type: 'sources_changed',
          sessionId: managed.id,
          enabledSourceSlugs: managed.enabledSourceSlugs || [],
        }, managed.workspace.id)

        return true
      }

      // NOTE: Source reloading is now handled by ConfigWatcher callbacks
      // which detect filesystem changes and update all affected sessions.
      // See setupConfigWatcher() for the full reload logic.

      // Apply session-scoped permission mode to the newly created agent
      // This ensures the UI toggle state is reflected in the agent before first message
      if (managed.permissionMode) {
        setPermissionMode(managed.id, managed.permissionMode)
        sessionLog.info(`Applied permission mode '${managed.permissionMode}' to agent for session ${managed.id}`)
      }
      end()
    }
    return managed.agent
  }

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = true
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_flagged', sessionId }, managed.workspace.id)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isFlagged = false
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unflagged', sessionId }, managed.workspace.id)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_archived', sessionId }, managed.workspace.id)
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unarchived', sessionId }, managed.workspace.id)
    }
  }

  async setTodoState(sessionId: string, todoState: TodoState): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.todoState = todoState
      // Persist in-memory state directly to avoid race with pending queue writes
      this.persistSession(managed)
      await this.flushSession(managed.id)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'todo_state_changed', sessionId, todoState }, managed.workspace.id)
    }
  }

  /**
   * For completed teammate sessions: mark done + archive so they no longer
   * clutter the sidebar and no longer participate in active-session UX flows.
   */
  private async autoArchiveCompletedTeammateSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed || !managed.parentSessionId || !managed.teammateName) return

    if (!managed.isProcessing && managed.agent) {
      this.destroyManagedAgent(managed, 'autoArchiveCompletedTeammateSession')
    }

    this.detachTeammateTracking(managed)
    managed.teamId = undefined
    managed.parentSessionId = undefined
    managed.teammateName = undefined

    let changed = false
    if (managed.todoState !== 'done') {
      managed.todoState = 'done'
      changed = true
    }
    if (!managed.isArchived) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      changed = true
    }
    if (!changed) return

    this.persistSession(managed)
    await this.flushSession(managed.id)

    // Notify renderer state changes (same shape as existing session actions).
    this.sendEvent({ type: 'todo_state_changed', sessionId: managed.id, todoState: managed.todoState ?? 'done' }, managed.workspace.id)
    this.sendEvent({ type: 'session_archived', sessionId: managed.id }, managed.workspace.id)
  }

  /**
   * Set the LLM connection for a session.
   * Can only be changed before the first message is sent (connection is locked after).
   * This determines which LLM provider/backend will be used for this session.
   */
  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    // Only allow changing connection before first message (session hasn't started)
    if (managed.messages && managed.messages.length > 0) {
      sessionLog.warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    // Validate connection exists
    const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      sessionLog.warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    // Persist in-memory state directly to avoid race with pending queue writes
    this.persistSession(managed)
    await this.flushSession(managed.id)
    sessionLog.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    // Notify UI that connection changed (triggers capabilities refresh)
    this.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
    }, managed.workspace.id)
  }

  // ============================================
  // Pending Plan Execution (Accept & Compact)
  // ============================================

  /**
   * Set pending plan execution state.
   * Called when user clicks "Accept & Compact" to persist the plan path
   * so execution can resume after compaction (even if page reloads).
   */
  async setPendingPlanExecution(sessionId: string, planPath: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, planPath)
      sessionLog.info(`Session ${sessionId}: set pending plan execution for ${planPath}`)
    }
  }

  /**
   * Mark compaction as complete for pending plan execution.
   * Called when compaction_complete event fires - allows reload recovery
   * to know that compaction finished and plan can be executed.
   */
  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  /**
   * Clear pending plan execution state.
   * Called after plan execution is triggered, on new user message,
   * or when the pending execution is no longer relevant.
   */
  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
      sessionLog.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  /**
   * Get pending plan execution state for a session.
   * Used on reload/init to check if we need to resume plan execution.
   */
  getPendingPlanExecution(sessionId: string): { planPath: string; awaitingCompaction: boolean } | null {
    const managed = this.sessions.get(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  // ============================================
  // Session Sharing
  // ============================================

  /**
   * Share session to the web viewer
   * Uploads session data and returns shareable URL
   */
  async shareToViewer(sessionId: string): Promise<import('../shared/types').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = await response.json() as { id: string; url: string }

      // Store shared info in session
      managed.sharedUrl = data.url
      managed.sharedId = data.id
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      sessionLog.info(`Session ${sessionId} shared at ${data.url}`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_shared', sessionId, sharedUrl: data.url }, managed.workspace.id)
      return { success: true, url: data.url }
    } catch (error) {
      sessionLog.error('Share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update an existing shared session
   * Re-uploads session data to the same URL
   */
  async updateShare(sessionId: string): Promise<import('../shared/types').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      // Load session directly from disk (already in correct format)
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession)
      })

      if (!response.ok) {
        sessionLog.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      sessionLog.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`)
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      sessionLog.error('Update share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Revoke a shared session
   * Deletes from viewer and clears local shared state
   */
  async revokeShare(sessionId: string): Promise<import('../shared/types').ShareResult> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    // Signal async operation start for shimmer effect
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(
        `${VIEWER_URL}/s/api/${managed.sharedId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        sessionLog.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      // Clear shared info
      delete managed.sharedUrl
      delete managed.sharedId
      const workspaceRootPath = managed.workspace.rootPath
      await updateSessionMetadata(workspaceRootPath, sessionId, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      sessionLog.info(`Session ${sessionId} share revoked`)
      // Notify all windows for this workspace
      this.sendEvent({ type: 'session_unshared', sessionId }, managed.workspace.id)
      return { success: true }
    } catch (error) {
      sessionLog.error('Revoke error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  // ============================================
  // Session Sources
  // ============================================

  /**
   * Update session's enabled sources
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sessionLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    for (const prevSlug of previousSlugs) {
      if (!newSlugs.has(prevSlug)) {
        const cachePath = getCredentialCachePath(workspaceRootPath, prevSlug)
        try {
          await rm(cachePath, { force: true }) // force: true ignores ENOENT
          sessionLog.debug(`Cleaned up credential cache for disabled source: ${prevSlug}`)
        } catch (err) {
          // Non-fatal - just log and continue
          sessionLog.warn(`Failed to clean up credential cache for ${prevSlug}: ${err}`)
        }
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      // For Copilot backend, write bridge config for API sources before setting servers
      if (managed.agent instanceof CopilotAgent) {
        const copilotConfigDir = join(sessionPath, '.copilot-config')
        await setupCopilotBridgeConfig(copilotConfigDir, sources.filter(isSourceUsable))
      }

      managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      // For Codex backend, regenerate config.toml and reconnect to pick up new sources
      // (Codex reads MCP config from file at startup, unlike Claude which has runtime injection)
      if (managed.agent instanceof CodexBackend) {
        await setupCodexSessionConfig(sessionPath, sources, mcpServers, managed.id, workspaceRootPath)
        await managed.agent.reconnect()
        sessionLog.info(`Codex config regenerated and reconnected for session ${managed.id}`)
      }

      sessionLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // Persist the session with updated sources
    this.persistSession(managed)

    // Notify renderer of the source change
    this.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sessionLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * Get the enabled source slugs for a session
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.sessions.get(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }

  /**
   * Get SDD state for a session.
   */
  getSessionSDDState(sessionId: string): {
    sddEnabled: boolean
    activeSpecId?: string
    sddComplianceReports: SpecComplianceReport[]
  } {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    if (managed.sddEnabled && !managed.activeSpecId) {
      // Fire-and-forget to ensure a spec exists for SDD sessions
      void this.ensureSessionActiveSpec(sessionId)
    }
    return {
      sddEnabled: managed.sddEnabled ?? false,
      activeSpecId: managed.activeSpecId,
      sddComplianceReports: managed.sddComplianceReports ?? [],
    }
  }

  /**
   * Enable/disable SDD mode for a session.
   */
  async setSessionSDDEnabled(sessionId: string, enabled: boolean): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    managed.sddEnabled = enabled
    if (!enabled) {
      managed.activeSpecId = undefined
      this.stopComplianceWatcher(sessionId)
    }
    // Update the live agent's session config so prompt builder picks up the change
    if (managed.agent) {
      const promptBuilder = managed.agent.getPromptBuilder()
      const session = promptBuilder.getSession()
      if (session) {
        session.sddEnabled = enabled
        if (!enabled) {
          session.activeSpecId = undefined
        }
      }
      if (!enabled) {
        promptBuilder.setSDDSpec(null)
      }
    }
    if (enabled) {
      this.startComplianceWatcher(sessionId)
    }
    this.persistSession(managed)
  }

  /**
   * Set active spec for a session.
   */
  async setSessionActiveSpec(sessionId: string, specId?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    managed.activeSpecId = specId
    let parsedSpec: Spec | null = null
    if (specId && existsSync(specId)) {
      const content = await readFile(specId, 'utf-8')
      parsedSpec = parseSpecMarkdown(content, specId)
      if (managed.teamId) {
        const resolvedTeamId = teamManager.resolveTeamId(managed.teamId)
        teamManager.setTeamSpec(resolvedTeamId, parsedSpec)
        if (parsedSpec) {
          const sectionKeys = [
            'goals',
            'nonGoals',
            'requirements',
            'risks',
            'mitigations',
            'rolloutPlan',
            'rollbackPlan',
            'testPlan',
            'observabilityPlan',
          ]
          const requirementIds = parsedSpec.requirements.map(req => req.id)
          const assignments: DRIAssignment[] = [{
            userId: parsedSpec.ownerDRI,
            role: 'owner',
            sections: [...sectionKeys, ...requirementIds],
            status: 'active',
          }]
          // Implements REQ-002: ensure DRI coverage for spec sections + requirements
          teamManager.setTeamDRIAssignments(resolvedTeamId, assignments)
        }
      }
    } else if (managed.teamId) {
      // Team manager currently stores full spec objects when available.
      // For ID-only updates, clear the cached spec to avoid stale linkage.
      const resolvedTeamId = teamManager.resolveTeamId(managed.teamId)
      teamManager.setTeamSpec(resolvedTeamId, undefined)
    }
    // Update the live agent's session config so prompt builder picks up the change
    if (managed.agent) {
      const promptBuilder = managed.agent.getPromptBuilder()
      const session = promptBuilder.getSession()
      if (session) {
        session.activeSpecId = specId
      }
      // Set cached spec when available
      promptBuilder.setSDDSpec(parsedSpec)
    }
    if (managed.sddEnabled && !managed.activeSpecId) {
      await this.ensureSessionActiveSpec(sessionId)
    }
    if (managed.sddEnabled) {
      this.startComplianceWatcher(sessionId)
    }
    this.persistSession(managed)
  }

  /**
   * Ensure an active spec exists for a session when SDD is enabled.
   * Creates a default spec file if needed and sets it as active.
   */
  async ensureSessionActiveSpec(sessionId: string): Promise<string | undefined> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    if (managed.activeSpecId) {
      if (managed.sddEnabled) {
        this.startComplianceWatcher(sessionId)
      }
      return managed.activeSpecId
    }

    const workspaceConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const templateId = workspaceConfig?.sdd?.defaultSpecTemplate
    const template = workspaceConfig?.sdd?.specTemplates?.find(t => t.id === templateId)

    const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
    const specsDir = join(sessionPath, 'specs')
    await mkdir(specsDir, { recursive: true })

    const datePrefix = new Date().toISOString().split('T')[0]
    let counter = 1
    let specPath = join(specsDir, `${datePrefix}-spec.md`)
    while (existsSync(specPath)) {
      counter += 1
      specPath = join(specsDir, `${datePrefix}-spec-${counter}.md`)
    }

    const title = managed.name ? `${managed.name} Spec` : 'Session Spec'
    const markdown = buildSpecMarkdown({
      title,
      ownerDRI: 'Unassigned',
      template,
    })

    await writeFile(specPath, markdown, 'utf-8')
    await this.setSessionActiveSpec(managed.id, specPath)
    if (managed.sddEnabled) {
      this.startComplianceWatcher(sessionId)
    }
    return managed.activeSpecId
  }

  /**
   * Update a requirement status in the active spec markdown and refresh cached spec.
   */
  async updateSpecRequirementStatus(
    sessionId: string,
    requirementId: string,
    status: 'pending' | 'in-progress' | 'implemented' | 'verified'
  ): Promise<Spec | null> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    if (!managed.activeSpecId || !existsSync(managed.activeSpecId)) {
      throw new Error('Active spec not found for this session')
    }

    const specPath = managed.activeSpecId
    const raw = await readFile(specPath, 'utf-8')
    const updated = updateRequirementStatusInMarkdown(raw, requirementId, status)
    if (updated !== raw) {
      await writeFile(specPath, updated, 'utf-8')
    }

    await this.setSessionActiveSpec(sessionId, specPath)
    const refreshed = managed.teamId
      ? teamManager.getTeamSpec(teamManager.resolveTeamId(managed.teamId))
      : undefined
    return refreshed ?? parseSpecMarkdown(updated, specPath)
  }

  /**
   * Get SDD compliance reports for a session.
   */
  getSessionComplianceReports(sessionId: string): SpecComplianceReport[] {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }
    return managed.sddComplianceReports ?? []
  }

  /**
   * Sync SDD compliance reports from persisted session metadata.
   * Useful when reports are generated out-of-band (e.g., CLI script).
   * Emits sdd_compliance_report events for any newly ingested reports.
   */
  async syncSessionComplianceReportsFromStorage(sessionId: string): Promise<SpecComplianceReport[]> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const stored = await loadStoredSession(managed.workspace.rootPath, sessionId)
    if (!stored) {
      return managed.sddComplianceReports ?? []
    }

    if (typeof stored.sddEnabled === 'boolean' && stored.sddEnabled !== managed.sddEnabled) {
      await this.setSessionSDDEnabled(sessionId, stored.sddEnabled)
    }

    if (stored.activeSpecId && stored.activeSpecId !== managed.activeSpecId) {
      await this.setSessionActiveSpec(sessionId, stored.activeSpecId)
    }

    if (managed.sddEnabled) {
      this.startComplianceWatcher(sessionId)
    }

    const storedReports = stored.sddComplianceReports ?? []
    const existingReports = managed.sddComplianceReports ?? []
    const existingKeys = new Set(
      existingReports.map(report => `${report.specId}:${report.timestamp}`)
    )
    const newReports = storedReports.filter(report => {
      const key = `${report.specId}:${report.timestamp}`
      return !existingKeys.has(key)
    })

    if (newReports.length > 0) {
      managed.sddComplianceReports = [...existingReports, ...newReports]
      this.persistSession(managed)
      for (const report of newReports) {
        this.sendEvent({
          type: 'sdd_compliance_report',
          sessionId,
          report,
        }, managed.workspace.id)
      }
    }

    return managed.sddComplianceReports ?? []
  }

  private startComplianceWatcher(sessionId: string): void {
    if (this.complianceWatchers.has(sessionId)) return
    const managed = this.sessions.get(sessionId)
    if (!managed || !managed.sddEnabled) return

    const sessionPath = getSessionStoragePath(managed.workspace.rootPath, managed.id)
    const reportsDir = join(sessionPath, 'reports')
    if (!existsSync(reportsDir)) {
      void mkdir(reportsDir, { recursive: true })
    }

    try {
      const watcher = watch(reportsDir, { recursive: false }, () => {
        const existingTimer = this.complianceSyncTimers.get(sessionId)
        if (existingTimer) clearTimeout(existingTimer)
        const timer = setTimeout(() => {
          void this.syncSessionComplianceReportsFromStorage(sessionId)
        }, 250)
        this.complianceSyncTimers.set(sessionId, timer)
      })
      this.complianceWatchers.set(sessionId, watcher)
      sessionLog.info(`Started compliance watcher for session ${sessionId}`)
    } catch (error) {
      sessionLog.warn(`Failed to start compliance watcher for ${sessionId}:`, error)
    }
  }

  private stopComplianceWatcher(sessionId: string): void {
    const watcher = this.complianceWatchers.get(sessionId)
    if (watcher) {
      watcher.close()
      this.complianceWatchers.delete(sessionId)
      sessionLog.info(`Stopped compliance watcher for session ${sessionId}`)
    }
    const timer = this.complianceSyncTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.complianceSyncTimers.delete(sessionId)
    }
  }

  /**
   * Get the last final assistant message ID from a list of messages
   * A "final" message is one where:
   * - role === 'assistant' AND
   * - isIntermediate !== true (not commentary between tool calls)
   * Returns undefined if no final assistant message exists
   */
  private getLastFinalAssistantMessageId(messages: Message[]): string | undefined {
    // Iterate backwards to find the most recent final assistant message
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }

  /**
   * Set which session the user is actively viewing.
   * Called when user navigates to a session. Used to determine whether to mark
   * new messages as unread - if user is viewing, don't mark unread.
   */
  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      // When user starts viewing a session that's not processing, clear unread
      const managed = this.sessions.get(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  /**
   * Clear active viewing session for a workspace.
   * Called when all windows leave a workspace to ensure read/unread state is correct.
   */
  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  /**
   * Check if a session is currently being viewed by the user
   */
  private isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  /**
   * Mark a session as read by setting lastReadMessageId and clearing hasUnread.
   * Called when user navigates to a session (and it's not processing).
   */
  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    // Only mark as read if not currently processing
    // (user is viewing but we want to wait for processing to complete)
    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    // Update lastReadMessageId for legacy/manual unread functionality
    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    // Clear hasUnread flag (primary source of truth for NEW badge)
    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    // Persist changes
    if (needsPersist) {
      this.persistSession(managed)
    }
  }

  /**
   * Mark a session as unread by setting hasUnread flag.
   * Called when user manually marks a session as unread via context menu.
   */
  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      // Persist to disk without re-loading session
      this.persistSession(managed)
    }
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.name = name
      this.persistSession(managed)
      // Notify renderer of the name change
      this.sendEvent({ type: 'title_generated', sessionId, title: name }, managed.workspace.id)
    }
  }

  /**
   * Regenerate the session title based on recent messages.
   * Uses the last few user messages to capture what the session has evolved into.
   * Automatically uses the same provider as the session (Claude or OpenAI).
   */
  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    sessionLog.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    // Ensure messages are loaded from disk (lazy loading support)
    await this.ensureMessagesLoaded(managed)

    // Get recent user messages (last 3) for context
    const userMessages = managed.messages
      .filter((m) => m.role === 'user')
      .slice(-3)
      .map((m) => m.content)

    sessionLog.info(`refreshTitle: Found ${userMessages.length} user messages`)

    if (userMessages.length === 0) {
      sessionLog.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    // Get the most recent assistant response
    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: connection ? getMiniModel(connection) : undefined,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }) as AgentInstance
        isTemporary = true
        sessionLog.info(`refreshTitle: Created temporary agent for session ${sessionId}`)
      } catch (error) {
        sessionLog.error(`refreshTitle: Failed to create temporary agent:`, error)
        return { success: false, error: 'Failed to create agent for title generation' }
      }
    }

    if (!agent) {
      sessionLog.warn(`refreshTitle: No agent and no connection for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    sessionLog.info(`refreshTitle: Calling agent.regenerateTitle...`)


    // Notify renderer that title regeneration has started (for shimmer effect)
    managed.isAsyncOperationOngoing = true
    this.sendEvent({ type: 'async_operation', sessionId, isOngoing: true }, managed.workspace.id)
    // Keep legacy event for backward compatibility
    this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: true }, managed.workspace.id)

    try {
      const title = await agent.regenerateTitle(userMessages, assistantResponse)
      sessionLog.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // title_generated will also clear isRegeneratingTitle via the event handler
        this.sendEvent({ type: 'title_generated', sessionId, title }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId}: "${title}"`)
        return { success: true, title }
      }
      // AI title generation failed — fall back to extractive title from user messages
      sessionLog.info(`refreshTitle: AI title generation returned null, using extractive fallback`)
      const lastUserMsg = userMessages[userMessages.length - 1] || ''
      const cleanMsg = lastUserMsg.replace(/[\n\r]+/g, ' ').replace(/\s+/g, ' ').trim()
      if (cleanMsg) {
        let fallbackTitle: string
        const sentenceEnd = cleanMsg.search(/[.!?]\s/)
        if (sentenceEnd > 0 && sentenceEnd <= 60) {
          fallbackTitle = cleanMsg.slice(0, sentenceEnd + 1)
        } else if (cleanMsg.length <= 60) {
          fallbackTitle = cleanMsg
        } else {
          const truncated = cleanMsg.slice(0, 57).replace(/\s+\S*$/, '').trim()
          fallbackTitle = truncated.length > 0 ? truncated + '...' : cleanMsg.slice(0, 57) + '...'
        }
        managed.name = fallbackTitle
        this.persistSession(managed)
        this.sendEvent({ type: 'title_generated', sessionId, title: fallbackTitle }, managed.workspace.id)
        sessionLog.info(`Refreshed title for session ${sessionId} (fallback): "${fallbackTitle}"`)
        return { success: true, title: fallbackTitle }
      }
      // No usable content — clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      return { success: false, error: 'Failed to generate title' }
    } catch (error) {
      // Error occurred - clear regenerating state
      this.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false }, managed.workspace.id)
      const message = error instanceof Error ? error.message : 'Unknown error'
      sessionLog.error(`Failed to refresh title for session ${sessionId}:`, error)
      return { success: false, error: message }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
      // Signal async operation end
      managed.isAsyncOperationOngoing = false
      this.sendEvent({ type: 'async_operation', sessionId, isOngoing: false }, managed.workspace.id)
    }
  }

  /**
   * Update the working directory for a session.
   *
   * If no messages have been sent yet (no SDK interaction), also updates sdkCwd
   * so the SDK will use the new path for transcript storage. This prevents the
   * confusing "bash shell runs from a different directory" warning when the user
   * changes the working directory before their first message.
   */
  updateWorkingDirectory(sessionId: string, path: string): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.workingDirectory = path

      // Check if we can also update sdkCwd (safe if no SDK interaction yet)
      // Conditions: no messages sent AND no agent created yet (no SDK session)
      const shouldUpdateSdkCwd =
        managed.messages.length === 0 &&
        !managed.sdkSessionId &&
        !managed.agent

      if (shouldUpdateSdkCwd) {
        managed.sdkCwd = path
        sessionLog.info(`Session ${sessionId}: sdkCwd updated to ${path} (no prior interaction)`)
      }

      // Also update the agent's session config if agent exists
      if (managed.agent) {
        managed.agent.updateWorkingDirectory(path)
        // If agent exists but conditions still allow sdkCwd update (edge case),
        // update the agent's sdkCwd as well
        if (shouldUpdateSdkCwd) {
          managed.agent.updateSdkCwd(path)
        }
      }

      this.persistSession(managed)
      // Notify renderer of the working directory change
      this.sendEvent({ type: 'working_directory_changed', sessionId, workingDirectory: path }, managed.workspace.id)
    }
  }

  /**
   * Update the model for a session
   * Pass null to clear the session-specific model (will use global config)
   * @param connection - Optional LLM connection slug (only applied if not already locked)
   */
  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.model = model ?? undefined
      // Also update connection if provided and not already locked
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection
      }
      const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
      const sessionConn = resolveSessionConnection(managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
      managed.llmProvider = sessionConn
        ? resolveUsageProvider(sessionConn.providerType, model ?? sessionConn.defaultModel)
        : inferProviderFromModel(model ?? managed.model)
      // Persist to disk (include connection if it was updated)
      const updates: { model?: string; llmProvider?: UsageProvider; llmConnection?: string } = {
        model: model ?? undefined,
        llmProvider: managed.llmProvider,
      }
      if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      // Update agent model if it already exists (takes effect on next query)
      if (managed.agent) {
        // Fallback chain: session model > workspace default > connection default
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!
        managed.agent.setModel(effectiveModel)
      }
      // Notify renderer of the model change
      this.sendEvent({ type: 'session_model_changed', sessionId, model }, managed.workspace.id)
      sessionLog.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  /**
   * Update the content of a specific message in a session
   * Used by preview window to save edited content back to the original message
   */
  updateMessageContent(sessionId: string, messageId: string, content: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot update message: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      sessionLog.warn(`Cannot update message: message ${messageId} not found in session ${sessionId}`)
      return
    }

    // Update the message content
    message.content = content
    // Persist the updated session
    this.persistSession(managed)
    sessionLog.info(`Updated message ${messageId} content in session ${sessionId}`)
  }

  async deleteSession(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      sessionLog.warn(`Cannot delete session: ${sessionId} not found`)
      return
    }

    // Ensure team resources are released before deleting a lead session.
    if (managed.isTeamLead && managed.teammateSessionIds?.length) {
      await this.cleanupTeam(sessionId)
    }

    // Get workspace slug before deleting
    const workspaceRootPath = managed.workspace.rootPath

    // If processing is in progress, force-abort via Query.close() and wait for cleanup
    if (managed.isProcessing && managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
      // Brief wait for the query to finish tearing down before we delete session files.
      // Prevents file corruption from overlapping writes during rapid delete operations.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    // Clean up delta flush timers to prevent orphaned timers
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }
    const kickoffTimer = this.teammateKickoffTimers.get(sessionId)
    if (kickoffTimer) {
      clearTimeout(kickoffTimer)
      this.teammateKickoffTimers.delete(sessionId)
    }
    this.pendingDeltas.delete(sessionId)

    // Cancel any pending persistence write (session is being deleted, no need to save)
    sessionPersistenceQueue.cancel(sessionId)

    // Dispose agent to clean up ConfigWatchers, event listeners, MCP connections
    if (managed.agent) {
      this.destroyManagedAgent(managed, 'deleteSession')
    } else {
      unregisterSessionScopedToolCallbacks(sessionId)
    }
    this.stopComplianceWatcher(sessionId)

    this.sessions.delete(sessionId)

    // Clean up session metadata in HookSystem (prevents memory leak)
    const hookSystem = this.hookSystems.get(workspaceRootPath)
    if (hookSystem) {
      hookSystem.removeSessionMetadata(sessionId)
    }

    // Delete from disk too
    deleteStoredSession(workspaceRootPath, sessionId)

    // Notify all windows for this workspace that the session was deleted
    this.sendEvent({ type: 'session_deleted', sessionId }, managed.workspace.id)

    // Clean up attachments directory (handled by deleteStoredSession for workspace-scoped storage)
    sessionLog.info(`Deleted session ${sessionId}`)
  }

  async sendMessage(sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions, existingMessageId?: string, _isAuthRetry?: boolean, _isReconnectRetry?: boolean): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      throw new Error(`Session ${sessionId} not found`)
    }

    // Deduplication guard: drop duplicate messages sent within 500ms.
    // The renderer sometimes sends the same message twice (~100-200ms apart),
    // which interrupts Codex sessions before they can initialize.
    // Skip dedup for queue-drain calls (existingMessageId) and auth retries.
    if (!existingMessageId && !_isAuthRetry && !_isReconnectRetry) {
      const now = Date.now()
      const lastDedup = managed.lastSendDedup
      if (lastDedup && lastDedup.content === message && (now - lastDedup.timestamp) < 500) {
        sessionLog.info(`Dedup: dropping duplicate message for session ${sessionId} (${now - lastDedup.timestamp}ms apart)`)
        return
      }
      managed.lastSendDedup = { content: message, timestamp: now }
    }

    // Clear any pending plan execution state when a new user message is sent.
    // This acts as a safety valve - if the user moves on, we don't want to
    // auto-execute an old plan later.
    await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)

    // Ensure messages are loaded before we try to add new ones
    await this.ensureMessagesLoaded(managed)

    // If currently processing, queue the message and interrupt via forceAbort.
    // The abort throws an AbortError (caught in the catch block) which calls
    // onProcessingStopped → processNextQueuedMessage to drain the queue.
    if (managed.isProcessing) {
      sessionLog.info(`Session ${sessionId} is processing, queueing message and interrupting`)

      // Create user message for queued state (so UI can show it)
      const queuedMessage: Message = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments,
        badges: options?.badges,
      }

      // Add to messages immediately so it's persisted
      managed.messages.push(queuedMessage)

      // Queue the message info (with the generated ID for later matching)
      managed.messageQueue.push({ message, attachments, storedAttachments, options, messageId: queuedMessage.id, optimisticMessageId: options?.optimisticMessageId })

      // Emit user_message event so UI can show queued state
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: queuedMessage,
        status: 'queued',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      // Force-abort via Query.close() - immediately stops processing.
      // The for-await loop will complete, triggering onProcessingStopped → queue drain.
      managed.agent?.forceAbort(AbortReason.Redirect)

      return
    }

    // Add user message with stored attachments for persistence
    // Skip if existingMessageId is provided (message was already created when queued)
    let userMessage: Message
    if (existingMessageId) {
      // Find existing message (already added when queued)
      userMessage = managed.messages.find(m => m.id === existingMessageId)!
      if (!userMessage) {
        throw new Error(`Existing message ${existingMessageId} not found`)
      }
    } else {
      // Create new message
      userMessage = {
        id: generateMessageId(),
        role: 'user',
        content: message,
        timestamp: this.monotonic(),
        attachments: storedAttachments, // Include for persistence (has thumbnailBase64)
        badges: options?.badges,  // Include content badges (sources, skills with embedded icons)
      }
      managed.messages.push(userMessage)

      // Update lastMessageRole for badge display
      managed.lastMessageRole = 'user'

      // Emit user_message event so UI can confirm the optimistic message
      this.sendEvent({
        type: 'user_message',
        sessionId,
        message: userMessage,
        status: 'accepted',
        optimisticMessageId: options?.optimisticMessageId
      }, managed.workspace.id)

      // If this is the first user message and no title exists, set one immediately
      // AI generation will enhance it later, but we always have a title from the start
      const isFirstUserMessage = managed.messages.filter(m => m.role === 'user').length === 1
      if (isFirstUserMessage && !managed.name) {
        // Replace bracket mentions with their display labels (e.g. [skill:ws:commit] -> "Commit")
        // so titles show human-readable names instead of raw IDs
        let titleSource = message
        if (options?.badges) {
          for (const badge of options.badges) {
            if (badge.rawText && badge.label) {
              titleSource = titleSource.replace(badge.rawText, badge.label)
            }
          }
        }
        // Sanitize: strip any remaining bracket mentions, XML blocks, tags
        const sanitized = sanitizeForTitle(titleSource)
        const initialTitle = sanitized.slice(0, 50) + (sanitized.length > 50 ? '…' : '')
        managed.name = initialTitle
        this.persistSession(managed)
        // Flush immediately so disk is authoritative before notifying renderer
        await this.flushSession(managed.id)
        this.sendEvent({
          type: 'title_generated',
          sessionId,
          title: initialTitle,
        }, managed.workspace.id)

        // Generate AI title asynchronously using agent's SDK
        // (waits briefly for agent creation if needed)
        this.generateTitle(managed, message)
      }
    }

    // Evaluate auto-label rules against the user message (common path for both
    // fresh and queued messages). Scans regex patterns configured on labels,
    // then merges any new matches into the session's label array.
    try {
      const labelTree = listLabels(managed.workspace.rootPath)
      const autoMatches = evaluateAutoLabels(message, labelTree)

      if (autoMatches.length > 0) {
        const existingLabels = managed.labels ?? []
        const newEntries = autoMatches
          .map(m => `${m.labelId}::${m.value}`)
          .filter(entry => !existingLabels.includes(entry))

        if (newEntries.length > 0) {
          managed.labels = [...existingLabels, ...newEntries]
          this.persistSession(managed)
          this.sendEvent({
            type: 'labels_changed',
            sessionId,
            labels: managed.labels,
          }, managed.workspace.id)
        }
      }
    } catch (e) {
      sessionLog.warn(`Auto-label evaluation failed for session ${sessionId}:`, e)
    }

    managed.lastMessageAt = Date.now()
    managed.isProcessing = true
    managed.streamingText = ''
    managed.processingGeneration++

    // Notify power manager that a session started processing
    // (may prevent display sleep if setting enabled)
    const { onSessionStarted } = await import('./power-manager')
    onSessionStarted()

    // Reset auth retry flag for this new message (allows one retry per message)
    // IMPORTANT: Skip reset if this is an auth retry call - the flag is already true
    // and resetting it would allow infinite retry loops
    // Note: authRetryInProgress is NOT reset here - it's managed by the retry logic
    if (!_isAuthRetry && !_isReconnectRetry) {
      managed.authRetryAttempted = false
      managed.connectionRetryAttempted = false
    }

    // Store message/attachments for potential retry after auth refresh
    // (SDK subprocess caches token at startup, so if it expires mid-session,
    // we need to recreate the agent and retry the message)
    managed.lastSentMessage = message
    managed.lastSentAttachments = attachments
    managed.lastSentStoredAttachments = storedAttachments
    managed.lastSentOptions = options

    // Capture the generation to detect if a new request supersedes this one.
    // This prevents the finally block from clobbering state when a follow-up message arrives.
    const myGeneration = managed.processingGeneration

    // Start perf span for entire sendMessage flow
    const sendSpan = perf.span('session.sendMessage', { sessionId })

    // Get or create the agent (lazy loading)
    const agent = await this.getOrCreateAgent(managed)
    sendSpan.mark('agent.ready')

    // Always set all sources for context (even if none are enabled), including built-ins
    const workspaceRootPath = managed.workspace.rootPath
    const allSources = loadAllSources(workspaceRootPath)
    agent.setAllSources(allSources)
    sendSpan.mark('sources.loaded')

    // Apply source servers if any are enabled
    if (managed.enabledSourceSlugs?.length) {
      // Always build server configs fresh (no caching - single source of truth)
      const sources = getSourcesBySlugs(workspaceRootPath, managed.enabledSourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, agent.getSummarizeCallback())
      if (errors.length > 0) {
        sessionLog.warn(`Source build errors:`, errors)
      }

      // Apply source servers to the agent
      const mcpCount = Object.keys(mcpServers).length
      const apiCount = Object.keys(apiServers).length
      if (mcpCount > 0 || apiCount > 0 || managed.enabledSourceSlugs.length > 0) {
        // Pass intended slugs so agent shows sources as active even if build failed
        const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

        // For Copilot backend, write bridge config for API sources before setting servers
        if (agent instanceof CopilotAgent) {
          const copilotConfigDir = join(sessionPath, '.copilot-config')
          await setupCopilotBridgeConfig(copilotConfigDir, sources.filter(isSourceUsable))
        }

        agent.setSourceServers(mcpServers, apiServers, intendedSlugs)
        sessionLog.info(`Applied ${mcpCount} MCP + ${apiCount} API sources to session ${sessionId} (${allSources.length} total)`)
      }
      sendSpan.mark('servers.applied')

      // Proactive OAuth token refresh before chat starts.
      // This ensures tokens are fresh BEFORE the first API call, avoiding mid-call auth failures.
      // Handles both MCP OAuth (Linear, Notion) and API OAuth (Gmail, Slack, Microsoft).
      if (managed.tokenRefreshManager) {
        const refreshResult = await refreshOAuthTokensIfNeeded(
          agent,
          sources,
          sessionPath,
          managed.tokenRefreshManager
        )
        if (refreshResult.failedSources.length > 0) {
          sessionLog.warn('[OAuth] Some sources failed token refresh:', refreshResult.failedSources.map(f => f.slug))
        }
        if (refreshResult.tokensRefreshed) {
          sendSpan.mark('oauth.refreshed')
        }
      }
    }

    try {
      sessionLog.info('Starting chat for session:', sessionId)
      sessionLog.info('Workspace:', JSON.stringify(managed.workspace, null, 2))
      sessionLog.info('Message:', message)
      sessionLog.info('Agent model:', agent.getModel())
      sessionLog.info('process.cwd():', process.cwd())

      // Set ultrathink override if enabled (single-shot - resets after query)
      // This boosts the session's thinkingLevel to 'max' for this message only
      if (options?.ultrathinkEnabled) {
        sessionLog.info('Ultrathink override ENABLED')
        agent.setUltrathinkOverride(true)
      }

      // Process the message through the agent
      sessionLog.info('Calling agent.chat()...')
      if (attachments?.length) {
        sessionLog.info('Attachments:', attachments.length)
      }

      // Skills mentioned via @mentions are handled by the SDK's Skill tool.
      // The UI layer (extractBadges in mentions.ts) injects fully-qualified names
      // in the rawText, and canUseTool in craft-agent.ts provides a fallback
      // to qualify short names. No transformation needed here.

      // Ensure main process reads tool metadata from the correct session directory.
      // This must be set before each chat() call since multiple sessions share the process.
      const chatSessionDir = getSessionStoragePath(workspaceRootPath, sessionId)
      toolMetadataStore.setSessionDir(chatSessionDir)

      sendSpan.mark('chat.starting')
      const chatIterator = agent.chat(message, attachments)
      sessionLog.info('Got chat iterator, starting iteration...')

      for await (const event of chatIterator) {
        // Log events (skip noisy text_delta)
        if (event.type !== 'text_delta') {
          if (event.type === 'tool_start') {
            sessionLog.info(`tool_start: ${event.toolName} (${event.toolUseId})`)
          } else if (event.type === 'tool_result') {
            sessionLog.info(`tool_result: ${event.toolUseId} isError=${event.isError}`)
          } else {
            sessionLog.info('Got event:', event.type)
          }
        }

        // Feed tool events to health monitor + dashboard for teammate sessions
        if (managed.parentSessionId && managed.teammateName && managed.teamId) {
          const hmTeamId = teamManager.resolveTeamId(managed.teamId)
          if (event.type === 'tool_start') {
            this.healthMonitor.recordActivity(hmTeamId, managed.id, managed.teammateName, {
              type: 'tool_call',
              toolName: event.toolName,
            })
            // Forward tool activity to dashboard for live visibility
            this.emitTeammateToolActivity(hmTeamId, managed.id, managed.teammateName, {
              toolName: event.toolName,
              toolDisplayName: event.displayName,
              toolIntent: event.intent,
              toolUseId: event.toolUseId,
              status: 'executing',
              inputPreview: event.input ? JSON.stringify(event.input).slice(0, 200) : undefined,
            })
          } else if (event.type === 'tool_result') {
            this.healthMonitor.recordActivity(hmTeamId, managed.id, managed.teammateName, {
              type: 'tool_result',
              toolName: event.toolName,
              error: event.isError,
            })
            // Forward tool completion to dashboard
            this.emitTeammateToolActivity(hmTeamId, managed.id, managed.teammateName, {
              toolName: event.toolName || 'unknown',
              toolUseId: event.toolUseId,
              status: event.isError ? 'error' : 'completed',
              resultPreview: event.result ? String(event.result).slice(0, 200) : undefined,
              isError: event.isError,
            })
          }
        }

        // Process the event first
        this.processEvent(managed, event)

        // Fallback: Capture SDK session ID if the onSdkSessionIdUpdate callback didn't fire.
        // Primary capture happens in getOrCreateAgent() via onSdkSessionIdUpdate callback,
        // which immediately flushes to disk. This fallback handles edge cases where the
        // callback might not fire (e.g., SDK version mismatch, callback not supported).
        if (!managed.sdkSessionId) {
          const sdkId = agent.getSessionId()
          if (sdkId) {
            managed.sdkSessionId = sdkId
            sessionLog.info(`Captured SDK session ID via fallback: ${sdkId}`)
            // Also flush here since we're in fallback mode
            this.persistSession(managed)
            sessionPersistenceQueue.flush(managed.id)
          }
        }

        // Handle complete event - SDK always sends this (even after interrupt)
        // This is the central place where processing ends
        if (event.type === 'complete') {
          // Skip normal completion handling if auth retry is in progress
          // The retry will handle its own completion
          if (managed.authRetryInProgress || managed.connectionRetryInProgress) {
            sessionLog.info('Chat completed but auth retry is in progress, skipping normal completion handling')
            sendSpan.mark('chat.complete.auth_retry_pending')
            sendSpan.end()
            return  // Exit function - retry will handle completion
          }

          sessionLog.info('Chat completed via complete event')

          // Check if we got an assistant response in this turn
          // If not, the SDK may have hit context limits or other issues
          const lastAssistantMsg = [...managed.messages].reverse().find(m =>
            m.role === 'assistant' && !m.isIntermediate
          )
          const lastUserMsg = [...managed.messages].reverse().find(m => m.role === 'user')

          // If the last user message is newer than any assistant response, we got no reply
          // This can happen due to context overflow or API issues - log for debugging but don't show UI warning
          if (lastUserMsg && (!lastAssistantMsg || lastUserMsg.timestamp > lastAssistantMsg.timestamp)) {
            sessionLog.warn(`Session ${sessionId} completed without assistant response - possible context overflow or API issue`)
          }

          sendSpan.mark('chat.complete')
          sendSpan.end()
          this.onProcessingStopped(sessionId, 'complete')
          return  // Exit function, skip finally block (onProcessingStopped handles cleanup)
        }

        // NOTE: We no longer break early on !isProcessing or stopRequested.
        // After soft interrupt (forceAbort), Codex sets turnComplete=true which causes
        // the generator to yield remaining queued events and then complete naturally.
        // This ensures we don't lose in-flight messages.
      }

      // Loop exited - either via complete event (normal) or generator ended after soft interrupt
      if (managed.stopRequested) {
        sessionLog.info('Chat loop completed after stop request - events drained successfully')
        this.onProcessingStopped(sessionId, 'interrupted')
      } else {
        sessionLog.info('Chat loop exited unexpectedly')
      }
    } catch (error) {
      // Check if this is an abort error (expected when interrupted)
      const isAbortError = error instanceof Error && (
        error.name === 'AbortError' ||
        error.message === 'Request was aborted.' ||
        error.message.includes('aborted')
      )

      if (isAbortError) {
        // Extract abort reason if available (safety net for unexpected abort propagation)
        const reason = (error as DOMException).cause as AbortReason | undefined

        sessionLog.info(`Chat aborted (reason: ${reason || 'unknown'})`)
        sendSpan.mark('chat.aborted')
        sendSpan.setMetadata('abort_reason', reason || 'unknown')
        sendSpan.end()

        // Plan submissions handle their own cleanup (they set isProcessing = false directly).
        // All other abort reasons route through onProcessingStopped for queue draining.
        if (reason === AbortReason.UserStop || reason === AbortReason.Redirect || reason === undefined) {
          this.onProcessingStopped(sessionId, 'interrupted')
        }
      } else {
        sessionLog.error('Error in chat:', error)
        sessionLog.error('Error message:', error instanceof Error ? error.message : String(error))
        sessionLog.error('Error stack:', error instanceof Error ? error.stack : 'No stack')

        // Report chat/SDK errors to Sentry for crash tracking
        Sentry.captureException(error, {
          tags: { errorSource: 'chat', sessionId },
        })

        sendSpan.mark('chat.error')
        sendSpan.setMetadata('error', error instanceof Error ? error.message : String(error))
        sendSpan.end()
        this.sendEvent({
          type: 'error',
          sessionId,
          error: error instanceof Error ? error.message : 'Unknown error'
        }, managed.workspace.id)
        // Handle error via centralized handler
        this.onProcessingStopped(sessionId, 'error')
      }
    } finally {
      // Only handle cleanup for unexpected exits (loop break without complete event)
      // Normal completion returns early after calling onProcessingStopped
      // Errors are handled in catch block
      if (managed.isProcessing && managed.processingGeneration === myGeneration) {
        if (managed.connectionRetryInProgress) {
          sessionLog.info('Skipping unexpected-exit cleanup because reconnect retry is in progress')
          return
        }
        sessionLog.info('Finally block cleanup - unexpected exit')
        sendSpan.mark('chat.unexpected_exit')
        sendSpan.end()
        this.onProcessingStopped(sessionId, 'interrupted')
      }
    }
  }

  async cancelProcessing(sessionId: string, silent = false): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed?.isProcessing) {
      return // Not processing, nothing to cancel
    }

    sessionLog.info('Cancelling processing for session:', sessionId, silent ? '(silent)' : '')

    // Clear queue - user explicitly stopped, don't process queued messages
    managed.messageQueue = []

    // Signal intent to stop - let the event loop drain remaining events before clearing isProcessing
    // This prevents losing in-flight messages from Codex after soft interrupt
    managed.stopRequested = true

    // Force-abort via Query.close() - sends soft interrupt to Codex
    if (managed.agent) {
      managed.agent.forceAbort(AbortReason.UserStop)
    }

    // Only show "Response interrupted" message when user explicitly clicked Stop
    // Silent mode is used when redirecting (sending new message while processing)
    if (!silent) {
      const interruptedMessage: Message = {
        id: generateMessageId(),
        role: 'info',
        content: 'Response interrupted',
        timestamp: this.monotonic(),
      }
      managed.messages.push(interruptedMessage)
      this.sendEvent({ type: 'interrupted', sessionId, message: interruptedMessage }, managed.workspace.id)
    } else {
      // Still send interrupted event but without the message (for UI state update)
      this.sendEvent({ type: 'interrupted', sessionId }, managed.workspace.id)
    }

    // Safety timeout: if event loop doesn't complete within 5 seconds, force cleanup
    // This handles cases where the generator gets stuck
    setTimeout(() => {
      if (managed.stopRequested && managed.isProcessing) {
        sessionLog.warn('Generator did not complete after stop request, forcing cleanup')
        this.onProcessingStopped(sessionId, 'timeout')
      }
    }, 5000)

    // NOTE: We don't clear isProcessing or send complete event here anymore.
    // The event loop will drain remaining events and call onProcessingStopped when done.
  }

  /**
   * SDD pre-completion hook.
   * Validates requirement coverage before allowing completion when enforced by workspace config.
   */
  private onBeforeSessionComplete(
    managed: ManagedSession
  ): { allowCompletion: boolean; blockMessage?: string; report?: SpecComplianceReport } {
    if (!managed.sddEnabled || !managed.activeSpecId) {
      return { allowCompletion: true }
    }

    const report = this.generateSpecComplianceReport(managed)
    if (!report) {
      return { allowCompletion: true }
    }

    const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const requireFullCoverage = wsConfig?.sdd?.requireFullCoverage === true

    if (managed.isTeamLead && managed.teamId) {
      const resolvedTeamId = teamManager.resolveTeamId(managed.teamId)
      const closeCheck = teamManager.canClosePlan(resolvedTeamId)
      if (!closeCheck.canClose) {
        return {
          allowCompletion: false,
          blockMessage: `[SDD] Completion blocked: ${closeCheck.blockers.join(' | ')}`,
          report,
        }
      }
    }

    if (requireFullCoverage && report.overallCoverage < 100) {
      return {
        allowCompletion: false,
        blockMessage: `[SDD] Completion blocked: requirement coverage is ${report.overallCoverage}%. Full coverage is required in this workspace.`,
        report,
      }
    }

    return { allowCompletion: true, report }
  }

  /**
   * SDD post-completion hook.
   * Persists compliance report in session metadata for UI retrieval.
   */
  private onAfterSessionComplete(
    managed: ManagedSession,
    reportFromBeforeHook?: SpecComplianceReport
  ): SpecComplianceReport | undefined {
    if (!managed.sddEnabled || !managed.activeSpecId) {
      return undefined
    }

    const report = reportFromBeforeHook ?? this.generateSpecComplianceReport(managed)
    if (!report) {
      return undefined
    }

    const reports = managed.sddComplianceReports ?? []
    managed.sddComplianceReports = [...reports, report]
    this.persistSession(managed)
    return report
  }

  /**
   * Scan the codebase for requirement ID references (e.g., REQ-001).
   * Implements BUG-3/BUG-4: populate referencedInFiles/referencedInTests with real data.
   */
  private scanCodebaseForRequirements(
    workingDir: string,
    requirementIds: string[],
  ): Map<string, { files: string[]; tests: string[] }> {
    const results = new Map<string, { files: string[]; tests: string[] }>()
    for (const id of requirementIds) {
      results.set(id, { files: [], tests: [] })
    }
    if (!requirementIds.length || !workingDir || !existsSync(workingDir)) return results

    // Build a combined pattern matching all requirement IDs
    const pattern = requirementIds.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')

    try {
      const isWin = process.platform === 'win32'
      let stdout = ''

      if (isWin) {
        // Windows: use findstr recursively with /S /N
        const { execSync } = require('child_process') as typeof import('child_process')
        try {
          stdout = execSync(
            `findstr /S /N /R "${pattern}" *.ts *.tsx *.js *.jsx *.py *.rs *.go`,
            { cwd: workingDir, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
          )
        } catch (e: any) {
          // findstr returns exit code 1 when no matches found
          if (e.stdout) stdout = e.stdout
        }
      } else {
        // Unix: use grep recursively
        const { execSync } = require('child_process') as typeof import('child_process')
        try {
          stdout = execSync(
            `grep -rn --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' --include='*.py' --include='*.rs' --include='*.go' -E "${pattern}" .`,
            { cwd: workingDir, timeout: 10000, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 }
          )
        } catch (e: any) {
          // grep returns exit code 1 when no matches found
          if (e.stdout) stdout = e.stdout
        }
      }

      if (!stdout) return results

      const lines = stdout.split('\n').filter(Boolean)
      const testFilePattern = /[./\\](test|spec|__tests__|__test__|e2e|integration)[./\\]|\.(?:test|spec)\.[^.]+$/i

      for (const line of lines) {
        // Extract file path (format: "filepath:lineNumber:content" or on Windows "filepath:lineNumber: content")
        const colonIdx = line.indexOf(':')
        if (colonIdx < 0) continue
        let filePath = line.substring(0, colonIdx)
        // Skip node_modules, dist, build, .git
        if (/node_modules|[/\\]dist[/\\]|[/\\]build[/\\]|[/\\]\.git[/\\]/i.test(filePath)) continue

        // Normalize path separators
        filePath = filePath.replace(/\\/g, '/')
        if (filePath.startsWith('./')) filePath = filePath.substring(2)

        const isTest = testFilePattern.test(filePath)

        // Match which requirement IDs this line references
        for (const reqId of requirementIds) {
          if (line.includes(reqId)) {
            const entry = results.get(reqId)!
            if (isTest) {
              if (!entry.tests.includes(filePath)) entry.tests.push(filePath)
            } else {
              if (!entry.files.includes(filePath)) entry.files.push(filePath)
            }
          }
        }
      }
    } catch (err) {
      sessionLog.warn('[SDD] Codebase scan failed (non-fatal):', err)
    }

    return results
  }

  /**
   * Build a compliance report from team task linkage AND codebase scanning.
   * Implements BUG-3: populate referencedInFiles/referencedInTests with real data.
   * Implements BUG-4: build real traceability maps from code references.
   */
  private generateSpecComplianceReport(managed: ManagedSession): SpecComplianceReport | undefined {
    if (!managed.activeSpecId) return undefined

    const teamId = managed.teamId ? teamManager.resolveTeamId(managed.teamId) : undefined
    const tasks = teamId ? teamManager.getTasks(teamId) : []
    const spec = teamId ? teamManager.getTeamSpec(teamId) : undefined

    const requirementIds = spec?.requirements.map(r => r.id)
      ?? [...new Set(tasks.flatMap(task => task.requirementIds ?? []))]

    // Implements BUG-3/BUG-4: scan codebase for actual requirement references
    const workingDir = managed.workingDirectory || managed.sdkCwd || ''
    const codebaseRefs = this.scanCodebaseForRequirements(workingDir, requirementIds)

    const requirementsCoverage = requirementIds.map(requirementId => {
      const linkedTasks = tasks.filter(task => (task.requirementIds ?? []).includes(requirementId))
      const refs = codebaseRefs.get(requirementId) ?? { files: [], tests: [] }

      const hasTasks = linkedTasks.length > 0
      const hasFiles = refs.files.length > 0
      const hasTests = refs.tests.length > 0
      const signals = [hasTasks, hasFiles, hasTests].filter(Boolean).length

      // Coverage: full = all 3 signals (or 2+ with files), partial = any 1+, none = 0
      const coverage: 'full' | 'partial' | 'none' =
        signals >= 2 && hasFiles ? 'full' :
        signals >= 1 ? 'partial' :
        'none'

      const noteParts: string[] = []
      if (hasTasks) noteParts.push(`${linkedTasks.length} task(s)`)
      if (hasFiles) noteParts.push(`${refs.files.length} file(s)`)
      if (hasTests) noteParts.push(`${refs.tests.length} test(s)`)

      return {
        requirementId,
        coverage,
        referencedInFiles: refs.files,
        referencedInTests: refs.tests,
        notes: noteParts.length > 0 ? noteParts.join(', ') : 'No references found',
      }
    })

    const fullCount = requirementsCoverage.filter(r => r.coverage === 'full').length
    const partialCount = requirementsCoverage.filter(r => r.coverage === 'partial').length
    const overallCoverage = requirementsCoverage.length > 0
      ? Math.round(((fullCount + partialCount * 0.5) / requirementsCoverage.length) * 100)
      : 100

    const unreferencedRequirements = requirementsCoverage
      .filter(r => r.coverage === 'none')
      .map(r => r.requirementId)

    // Implements BUG-4: build traceability map with real file/test data
    const traceabilityMap = requirementsCoverage.map(r => {
      const refs = codebaseRefs.get(r.requirementId) ?? { files: [], tests: [] }
      return {
        requirementId: r.requirementId,
        files: refs.files,
        tests: refs.tests,
        tasks: tasks
          .filter(task => (task.requirementIds ?? []).includes(r.requirementId))
          .map(task => task.id),
        tickets: tasks
          .flatMap(task => task.ticketLinks ?? [])
          .filter(ticket => (ticket.requirementIds ?? []).includes(r.requirementId))
          .map(ticket => ticket.ticketId),
      }
    })

    const hasRollbackPlan = !!spec?.rollbackPlan || tasks.some(t => /rollback/i.test(t.title))
    const hasMonitoring = !!spec?.observabilityPlan || tasks.some(t => /monitor/i.test(t.title))
    const hasFeatureFlags = tasks.some(t => /feature flag/i.test(t.title) || /flag/i.test(t.description || ''))

    return {
      specId: managed.activeSpecId,
      timestamp: new Date().toISOString(),
      overallCoverage,
      requirementsCoverage,
      unreferencedRequirements,
      traceabilityMap,
      rolloutSafetyCheck: {
        hasRollbackPlan,
        hasMonitoring,
        hasFeatureFlags,
        issues: [
          ...(hasRollbackPlan ? [] : ['Missing rollback plan']),
          ...(hasMonitoring ? [] : ['Missing monitoring plan']),
          ...(hasFeatureFlags ? [] : ['No feature-flag strategy detected']),
        ],
      },
    }
  }

  /**
   * Central handler for when processing stops (any reason).
   * Single source of truth for cleanup and queue processing.
   *
   * @param sessionId - The session that stopped processing
   * @param reason - Why processing stopped ('complete' | 'interrupted' | 'error')
   */
  private async onProcessingStopped(
    sessionId: string,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout'
  ): Promise<void> {
    const managed = this.sessions.get(sessionId)
    if (!managed) return

    sessionLog.info(`Processing stopped for session ${sessionId}: ${reason}`)

    if ((reason === 'error' || reason === 'timeout') && managed.parentSessionId && managed.teammateName) {
      const resolvedTeamId = teamManager.resolveTeamId(managed.teamId ?? managed.parentSessionId)
      this.updateTeammateTasks(resolvedTeamId, managed.id, 'failed')
    }

    // 1. Cleanup state
    managed.isProcessing = false
    managed.stopRequested = false  // Reset for next turn

    // Notify power manager that a session stopped processing
    // (may allow display sleep if no other sessions are active)
    const { onSessionStopped } = await import('./power-manager')
    onSessionStopped()

    // SDD pre/post completion hooks
    if (reason === 'complete') {
      const beforeResult = this.onBeforeSessionComplete(managed)
      if (!beforeResult.allowCompletion && beforeResult.blockMessage) {
        const warningMessage: Message = {
          id: generateMessageId(),
          role: 'warning',
          content: beforeResult.blockMessage,
          timestamp: Date.now(),
          infoLevel: 'warning',
        }
        managed.messages.push(warningMessage)
        this.sendEvent({
          type: 'info',
          sessionId,
          message: beforeResult.blockMessage,
          level: 'warning',
        }, managed.workspace.id)
      }

      const complianceReport = this.onAfterSessionComplete(managed, beforeResult.report)
      if (complianceReport) {
        this.sendEvent({
          type: 'sdd_compliance_report',
          sessionId,
          report: complianceReport,
        }, managed.workspace.id)
      }

      if (!beforeResult.allowCompletion) {
        // Implements REQ-002: hard-block completion when SDD gates fail
        this.persistSession(managed)
        return
      }
    }

    // 2. Handle unread state based on whether user is viewing this session
    //    This is the explicit state machine for NEW badge:
    //    - If user is viewing: mark as read (they saw it complete)
    //    - If user is NOT viewing: mark as unread (they have new content)
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const hasFinalMessage = this.getLastFinalAssistantMessageId(managed.messages) !== undefined

      if (reason === 'complete' && hasFinalMessage) {
        if (isViewing) {
          // User is watching - mark as read immediately
          await this.markSessionRead(sessionId)
        } else {
          // User is not watching - mark as unread for NEW badge
          if (!managed.hasUnread) {
            managed.hasUnread = true
            this.persistSession(managed)
          }
        }
      }

    // 3. Auto-complete mini agent sessions to avoid session list clutter
    //    Mini agents are spawned from EditPopovers for quick config edits
    //    and should automatically move to 'done' when finished
    if (reason === 'complete' && managed.systemPromptPreset === 'mini' && managed.todoState !== 'done') {
      sessionLog.info(`Auto-completing mini agent session ${sessionId}`)
      await this.setTodoState(sessionId, 'done')
    }

    // 4. Agent Teams: When a teammate session completes, run quality gates then relay results
    //    This MUST happen before step 5 (queue/complete) so the lead gets the message
    //    while it's still alive and listening.
    if (reason === 'complete' && managed.parentSessionId && managed.teammateName) {
      const lead = this.sessions.get(managed.parentSessionId)
        if (lead && lead.isTeamLead) {
          const lastAssistantMsg = [...managed.messages].reverse().find(m =>
            m.role === 'assistant' && !m.isIntermediate
          )
          const resultContent = lastAssistantMsg?.content || '(No output produced)'
          const teammateName = managed.teammateName
          const resolvedTeamId = teamManager.resolveTeamId(managed.teamId ?? managed.parentSessionId)

          // Load quality gate config from workspace
          const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
          const qgConfig = mergeQualityGateConfig(wsConfig?.agentTeams?.qualityGates as Partial<QualityGateConfig> | undefined)
          const clearLeadTeamState = (): void => {
            if (lead.agent instanceof CraftAgent) {
              lead.agent.clearTeamState()
            }
          }

        // Run quality gate pipeline if enabled
        if (qgConfig.enabled) {
          sessionLog.info(`[AgentTeams] Running quality gate pipeline for teammate "${teammateName}"`)

          const cycleKey = `${sessionId}-qg`
          const currentCycle = (this.qualityGateCycles.get(cycleKey) || 0) + 1
          this.qualityGateCycles.set(cycleKey, currentCycle)

          const runner = this.getQualityGateRunner()
          const taskContext: TaskContext = {
            taskDescription: managed.name || 'Teammate task',
            workingDirectory: managed.workingDirectory,
          }

          try {
            const spec = managed.teamId ? teamManager.getTeamSpec(teamManager.resolveTeamId(managed.teamId)) : undefined
            const reviewDiff = managed.workingDirectory
              ? await DiffCollector.collectWorkingDiff(managed.workingDirectory)
              : null
            const reviewInput = resolveQualityGateReviewInput(reviewDiff)

            if (!reviewInput.usesGitDiff) {
              sessionLog.warn(`[AgentTeams] Quality gate blocked for "${teammateName}" due to missing diff evidence`)
              if (currentCycle >= qgConfig.maxReviewCycles) {
                this.qualityGateCycles.delete(cycleKey)
                setTimeout(async () => {
                  try {
                    const relayMessage = [
                      `## Team Result - ${teammateName}`,
                      '',
                      '### Quality Gate Escalated',
                      `Cycle: ${currentCycle}/${qgConfig.maxReviewCycles}`,
                      `Reason: ${reviewInput.failureReason}`,
                      '',
                      'Action required: ensure teammate changes are present in the git working tree before re-running quality gates.',
                      '',
                      '---',
                      '',
                      resultContent,
                    ].join('\n')
                    await this.sendMessage(managed.parentSessionId!, relayMessage)
                    await this.autoArchiveCompletedTeammateSession(sessionId)
                  } catch (err) {
                    sessionLog.error(`[AgentTeams] Failed to relay missing-diff escalation from ${teammateName}:`, err)
                  }
                }, 200)
              } else {
                setTimeout(async () => {
                  try {
                    const feedbackMessage = [
                      '## Quality Gate Feedback',
                      `Cycle ${currentCycle}/${qgConfig.maxReviewCycles}`,
                      '',
                      'Your work did not pass quality checks.',
                      '',
                      `Blocking issue: ${reviewInput.failureReason}`,
                      '',
                      'Please make sure implementation changes are written to files in the working directory, then try again.',
                    ].join('\n')
                    await this.sendMessage(sessionId, feedbackMessage)
                  } catch (err) {
                    sessionLog.error(`[AgentTeams] Failed to send missing-diff feedback to ${teammateName}:`, err)
                  }
                }, 200)
              }
            }

            if (reviewInput.usesGitDiff) {
              const result = await runner.runProgressive(reviewInput.reviewInput, taskContext, qgConfig, spec)
            result.cycleCount = currentCycle
            result.maxCycles = qgConfig.maxReviewCycles

            // Implements BUG-7: store quality gate result for dashboard access
            teamManager.storeQualityResult(resolvedTeamId, managed.id, result)

            if (result.passed) {
              // PASSED — relay to lead with quality report
              sessionLog.info(`[AgentTeams] Quality gate PASSED for "${teammateName}" (score: ${result.aggregateScore})`)
              this.qualityGateCycles.delete(cycleKey) // Reset cycle counter

              const successReport = formatSuccessReport(result)
              const leadQualitySummary = buildQualityLeadSummary(teammateName, result, 'passed')
              teamManager.logActivity(
                resolvedTeamId,
                'quality-gate-passed',
                `Quality gate passed at ${formatPercentScore(result.aggregateScore)}`,
                managed.id,
                teammateName,
              )
              this.updateTeammateTasks(resolvedTeamId, managed.id, 'completed')

              setTimeout(async () => {
                try {
                  const relayMessage = [
                    `## Team Result - ${teammateName}`,
                    '',
                    leadQualitySummary,
                    '',
                    successReport,
                    '',
                    '---',
                    '',
                    resultContent,
                  ].join('\n')
                  await this.sendMessage(managed.parentSessionId!, relayMessage)
                  await this.autoArchiveCompletedTeammateSession(sessionId)

                  // Check if ALL teammates are now done
                  const allDone = (lead.teammateSessionIds || []).every(tid => {
                    const t = this.sessions.get(tid)
                    return t && !t.isProcessing
                  })
                  if (allDone) {
                    sessionLog.info(`[AgentTeams] All teammates complete for lead ${managed.parentSessionId}, prompting synthesis`)
                    clearLeadTeamState()
                    setTimeout(async () => {
                      try {
                        await this.sendMessage(managed.parentSessionId!, '[System] All teammates have completed their work. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
                      } catch (err) {
                        sessionLog.error('[AgentTeams] Failed to send synthesis prompt:', err)
                      }
                    }, 500)
                  }
                } catch (err) {
                  sessionLog.error(`[AgentTeams] Failed to relay results from ${teammateName}:`, err)
                }
              }, 200)

            } else if (currentCycle >= qgConfig.maxReviewCycles) {
              // MAX CYCLES REACHED — escalate and relay with warning
              sessionLog.warn(`[AgentTeams] Quality gate max cycles (${qgConfig.maxReviewCycles}) reached for "${teammateName}", escalating`)
              this.qualityGateCycles.delete(cycleKey)

              let escalationNote = ''
              try {
                escalationNote = await runner.escalate(result, resultContent, taskContext, qgConfig)
                result.escalatedTo = qgConfig.escalationModel
              } catch (err) {
                sessionLog.error('[AgentTeams] Escalation failed:', err)
                escalationNote = 'Escalation failed — manual review required.'
              }

              const failureReport = formatFailureReport(result, qgConfig)
              const leadQualitySummary = buildQualityLeadSummary(teammateName, result, 'escalated')
              teamManager.logActivity(
                resolvedTeamId,
                'escalation',
                `Quality gate escalated at ${formatPercentScore(result.aggregateScore)} after ${currentCycle} cycles`,
                managed.id,
                teammateName,
              )

              setTimeout(async () => {
                try {
                  const relayMessage = [
                    `## Team Result - ${teammateName}`,
                    '',
                    leadQualitySummary,
                    '',
                    failureReport,
                    '',
                    '**Escalation Diagnosis:**',
                    escalationNote,
                    '',
                    '---',
                    '',
                    resultContent,
                  ].join('\n')
                  await this.sendMessage(managed.parentSessionId!, relayMessage)
                  await this.autoArchiveCompletedTeammateSession(sessionId)
                } catch (err) {
                  sessionLog.error(`[AgentTeams] Failed to relay escalated results from ${teammateName}:`, err)
                }
              }, 200)

            } else {
              // FAILED — auto-cycle: send feedback back to teammate for fixes
              sessionLog.info(`[AgentTeams] Quality gate FAILED for "${teammateName}" (score: ${result.aggregateScore}, cycle ${currentCycle}/${qgConfig.maxReviewCycles})`)

              const failureReport = formatFailureReport(result, qgConfig)
              const workerFeedbackSummary = buildWorkerQualityFeedback(result, qgConfig.maxReviewCycles)
              teamManager.logActivity(
                resolvedTeamId,
                'quality-gate-failed',
                `Quality gate failed at ${formatPercentScore(result.aggregateScore)} (cycle ${currentCycle}/${qgConfig.maxReviewCycles})`,
                managed.id,
                teammateName,
              )

              setTimeout(async () => {
                try {
                  const feedbackMessage = [
                    workerFeedbackSummary,
                    '',
                    failureReport,
                  ].join('\n')
                  await this.sendMessage(sessionId, feedbackMessage)
                  teamManager.logActivity(
                    resolvedTeamId,
                    'review-feedback-sent',
                    `Quality feedback sent (cycle ${currentCycle}/${qgConfig.maxReviewCycles})`,
                    managed.id,
                    teammateName,
                  )
                } catch (err) {
                  sessionLog.error(`[AgentTeams] Failed to send quality gate feedback to ${teammateName}:`, err)
                }
              }, 200)
            }
            }
          } catch (err) {
            // Quality gate pipeline itself errored — don't block relay, just warn
            sessionLog.error(`[AgentTeams] Quality gate pipeline error for "${teammateName}":`, err)
            this.qualityGateCycles.delete(cycleKey)

            // Fallback: relay without quality report
            setTimeout(async () => {
              try {
                const relayMessage = `[Team Result] Teammate "${teammateName}" has completed their work (quality gate skipped due to error):\n\n${resultContent}`
                await this.sendMessage(managed.parentSessionId!, relayMessage)
                await this.autoArchiveCompletedTeammateSession(sessionId)
              } catch (relayErr) {
                sessionLog.error(`[AgentTeams] Failed to relay results from ${teammateName}:`, relayErr)
              }
            }, 200)
          }
        } else {
          // Quality gates disabled — original behavior
          sessionLog.info(`[AgentTeams] Relaying results from teammate "${teammateName}" back to lead ${managed.parentSessionId}`)
          const resolvedTeamId = teamManager.resolveTeamId(managed.teamId ?? managed.parentSessionId!)
          this.updateTeammateTasks(resolvedTeamId, managed.id, 'completed')

          setTimeout(async () => {
            try {
              const relayMessage = `[Team Result] Teammate "${teammateName}" has completed their work:\n\n${resultContent}`
              await this.sendMessage(managed.parentSessionId!, relayMessage)
              await this.autoArchiveCompletedTeammateSession(sessionId)

              const allDone = (lead.teammateSessionIds || []).every(tid => {
                const t = this.sessions.get(tid)
                return t && !t.isProcessing
              })
               if (allDone) {
                 sessionLog.info(`[AgentTeams] All teammates complete for lead ${managed.parentSessionId}, prompting synthesis`)
                 clearLeadTeamState()
                 setTimeout(async () => {
                  try {
                    await this.sendMessage(managed.parentSessionId!, '[System] All teammates have completed their work. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
                  } catch (err) {
                    sessionLog.error('[AgentTeams] Failed to send synthesis prompt:', err)
                  }
                }, 500)
              }
            } catch (err) {
              sessionLog.error(`[AgentTeams] Failed to relay results from ${teammateName}:`, err)
            }
          }, 200)
        }
      }
    }

    const keepAliveForTeam = this.shouldDelayCompletionForAgentTeam(managed)

    // 5. Check queue and process or complete
    if (managed.messageQueue.length > 0) {
      // Has queued messages - process next
      this.processNextQueuedMessage(sessionId)
    } else if (!keepAliveForTeam) {
      // No queue - emit complete to UI (include tokenUsage and hasUnread for state updates)
      this.sendEvent({
        type: 'complete',
        sessionId,
        tokenUsage: managed.tokenUsage,
        hasUnread: managed.hasUnread,  // Propagate unread state to renderer
      }, managed.workspace.id)
    } else {
      sessionLog.info(`[AgentTeams] Delaying completion for lead session ${sessionId} while teammates finish`)
    }

    // 6. Always persist
    this.persistSession(managed)
    void this.persistAndBroadcastUsage(managed)
  }

  private shouldDelayCompletionForAgentTeam(managed: ManagedSession): boolean {
    // Check if this session is a team lead with active teammate sessions
    if (!managed.isTeamLead || !managed.teammateSessionIds?.length) {
      return false
    }

    // Check if any teammates are still processing
    const hasActiveTeammates = managed.teammateSessionIds.some(teammateId => {
      const teammate = this.sessions.get(teammateId)
      return teammate?.isProcessing === true
    })

    return hasActiveTeammates
  }

  /**
   * Process the next message in the queue.
   * Called by onProcessingStopped when queue has messages.
   */
  private processNextQueuedMessage(sessionId: string): void {
    const managed = this.sessions.get(sessionId)
    if (!managed || managed.messageQueue.length === 0) return

    const next = managed.messageQueue.shift()!
    sessionLog.info(`Processing queued message for session ${sessionId}`)

    // Update UI: queued → processing
    if (next.messageId) {
      const existingMessage = managed.messages.find(m => m.id === next.messageId)
      if (existingMessage) {
        // Clear isQueued flag and persist - prevents re-queueing if crash during processing
        existingMessage.isQueued = false
        this.persistSession(managed)

        this.sendEvent({
          type: 'user_message',
          sessionId,
          message: existingMessage,
          status: 'processing',
          optimisticMessageId: next.optimisticMessageId
        }, managed.workspace.id)
      }
    }

    // Process message (use setImmediate to allow current stack to clear)
    setImmediate(() => {
      this.sendMessage(
        sessionId,
        next.message,
        next.attachments,
        next.storedAttachments,
        next.options,
        next.messageId
      ).catch(err => {
        sessionLog.error('Error processing queued message:', err)
        // Report queued message failures to Sentry — these indicate SDK/chat pipeline errors
        Sentry.captureException(err, {
          tags: { errorSource: 'chat-queue', sessionId },
        })
        this.sendEvent({
          type: 'error',
          sessionId,
          error: err instanceof Error ? err.message : 'Unknown error'
        }, managed.workspace.id)
        // Call onProcessingStopped to handle cleanup and check for more queued messages
        this.onProcessingStopped(sessionId, 'error')
      })
    })
  }

  async killShell(sessionId: string, shellId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.sessions.get(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    sessionLog.info(`Killing shell ${shellId} for session: ${sessionId}`)

    // Try to kill the actual process using the stored command
    const command = managed.backgroundShellCommands.get(shellId)
    if (command) {
      try {
        // Use pkill to find and kill processes matching the command
        // The -f flag matches against the full command line
        const { exec } = await import('child_process')
        const { promisify } = await import('util')
        const execAsync = promisify(exec)

        // Escape the command for use in pkill pattern
        // We search for the unique command string in process args
        const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

        sessionLog.info(`Attempting to kill process with command: ${command.slice(0, 100)}...`)

        // Use pgrep first to find the PID, then kill it
        // This is safer than pkill -f which can match too broadly
        try {
          const { stdout } = await execAsync(`pgrep -f "${escapedCommand}"`)
          const pids = stdout.trim().split('\n').filter(Boolean)

          if (pids.length > 0) {
            sessionLog.info(`Found ${pids.length} process(es) to kill: ${pids.join(', ')}`)
            // Kill each process
            for (const pid of pids) {
              try {
                await execAsync(`kill -TERM ${pid}`)
                sessionLog.info(`Sent SIGTERM to process ${pid}`)
              } catch (killErr) {
                // Process may have already exited
                sessionLog.warn(`Failed to kill process ${pid}: ${killErr}`)
              }
            }
          } else {
            sessionLog.info(`No processes found matching command`)
          }
        } catch (pgrepErr) {
          // pgrep returns exit code 1 when no processes found, which is fine
          sessionLog.info(`No matching processes found (pgrep returned no results)`)
        }

        // Clean up the stored command
        managed.backgroundShellCommands.delete(shellId)
      } catch (err) {
        sessionLog.error(`Error killing shell process: ${err}`)
      }
    } else {
      sessionLog.warn(`No command stored for shell ${shellId}, cannot kill process`)
    }

    // Always emit shell_killed to remove from UI regardless of process kill success
    this.sendEvent({
      type: 'shell_killed',
      sessionId,
      shellId,
    }, managed.workspace.id)

    return { success: true }
  }

  /**
   * Get output from a background task or shell
   * @param taskId - The task or shell ID
   * @returns Latest known output (best-effort) or null if not found
   */
  async getTaskOutput(taskId: string): Promise<string | null> {
    sessionLog.info(`Getting output for task: ${taskId}`)

    const allMessages: Message[] = []
    for (const managed of this.sessions.values()) {
      allMessages.push(...managed.messages)
    }

    // Newest-first search for matching output in tool messages.
    for (let i = allMessages.length - 1; i >= 0; i--) {
      const message = allMessages[i]
      if (message.role !== 'tool') continue
      const input = (message.toolInput ?? {}) as Record<string, unknown>
      const content = message.toolResult || message.content || ''

      const taskIdFromInput =
        (typeof input.task_id === 'string' && input.task_id) ||
        (typeof input.shell_id === 'string' && input.shell_id) ||
        (typeof input.backgroundTaskId === 'string' && input.backgroundTaskId) ||
        (typeof input.taskId === 'string' && input.taskId) ||
        (typeof input.shellId === 'string' && input.shellId) ||
        null

      if (taskIdFromInput === taskId) {
        return content || null
      }

      // Fallback for providers that only include IDs in result text.
      if (typeof content === 'string' && content.includes(taskId)) {
        return content
      }
    }

    return null
  }

  /**
   * Respond to a pending permission request
   * Returns true if the response was delivered, false if agent/session is gone
   */
  respondToPermission(sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean): boolean {
    const managed = this.sessions.get(sessionId)
    if (managed?.agent) {
      sessionLog.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      return true
    } else {
      sessionLog.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  /**
   * Respond to a pending credential request
   * Returns true if the response was delivered, false if no pending request found
   *
   * Supports both:
   * - New unified auth flow (via handleCredentialInput)
   * - Legacy callback flow (via pendingCredentialResolvers)
   */
  async respondToCredential(sessionId: string, requestId: string, response: import('../shared/types').CredentialResponse): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.sessions.get(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      sessionLog.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      sessionLog.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      sessionLog.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  /**
   * Set the permission mode for a session ('safe', 'ask', 'allow-all')
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update permission mode
      managed.permissionMode = mode

      // Update the mode state for this specific session via mode manager
      setPermissionMode(sessionId, mode)

      this.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
      }, managed.workspace.id)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Set labels for a session (additive tags, many-per-session).
   * Labels are IDs referencing workspace labels/config.json.
   */
  setSessionLabels(sessionId: string, labels: string[]): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      managed.labels = labels

      this.sendEvent({
        type: 'labels_changed',
        sessionId: managed.id,
        labels: managed.labels,
      }, managed.workspace.id)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Set the thinking level for a session ('off', 'think', 'max')
   * This is sticky and persisted across messages.
   */
  setSessionThinkingLevel(sessionId: string, level: ThinkingLevel): void {
    const managed = this.sessions.get(sessionId)
    if (managed) {
      // Update thinking level in managed session
      managed.thinkingLevel = level

      // Update the agent's thinking level if it exists
      if (managed.agent) {
        managed.agent.setThinkingLevel(level)
      }

      sessionLog.info(`Session ${sessionId}: thinking level set to ${level}`)
      // Persist to disk
      this.persistSession(managed)
    }
  }

  /**
   * Generate an AI title for a session from the user's first message.
   * Uses the agent's generateTitle() method which handles provider-specific SDK calls.
   * If no agent exists, creates a temporary one using the session's connection.
   */
  private async generateTitle(managed: ManagedSession, userMessage: string): Promise<void> {
    sessionLog.info(`[generateTitle] Starting for session ${managed.id}`)

    // Use existing agent or create temporary one
    let agent: AgentInstance | null = managed.agent
    let isTemporary = false

    // Wait briefly for agent to be created (it's created concurrently)
    if (!agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
      agent = managed.agent
    }

    // If still no agent, create a temporary one using the session's connection
    if (!agent && managed.llmConnection) {
      try {
        const connection = getLlmConnection(managed.llmConnection)
        agent = createBackendFromConnection(managed.llmConnection, {
          workspace: managed.workspace,
          miniModel: connection ? getMiniModel(connection) : undefined,
          session: {
            id: `title-${managed.id}`,
            workspaceRootPath: managed.workspace.rootPath,
            llmConnection: managed.llmConnection,
            createdAt: Date.now(),
            lastUsedAt: Date.now(),
          },
          isHeadless: true,
        }) as AgentInstance
        isTemporary = true
        sessionLog.info(`[generateTitle] Created temporary agent for session ${managed.id}`)
      } catch (error) {
        sessionLog.error(`[generateTitle] Failed to create temporary agent:`, error)
        return
      }
    }

    if (!agent) {
      sessionLog.warn(`[generateTitle] No agent and no connection for session ${managed.id}`)
      return
    }

    try {
      const title = await agent.generateTitle(userMessage)
      if (title) {
        managed.name = title
        this.persistSession(managed)
        // Flush immediately to ensure disk is up-to-date before notifying renderer.
        // This prevents race condition where lazy loading reads stale disk data
        // (the persistence queue has a 500ms debounce).
        await this.flushSession(managed.id)
        // Now safe to notify renderer - disk is authoritative
        this.sendEvent({ type: 'title_generated', sessionId: managed.id, title }, managed.workspace.id)
        sessionLog.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        sessionLog.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      sessionLog.error(`Failed to generate title for session ${managed.id}:`, error)

      // Surface quota/auth errors to the user — these indicate the main chat call will also fail
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('quota') || errorMsg.includes('429') || errorMsg.includes('401') || errorMsg.includes('insufficient')) {
        this.sendEvent({
          type: 'typed_error',
          sessionId: managed.id,
          error: {
            code: 'provider_error',
            title: 'API Error',
            message: `API error: ${errorMsg.slice(0, 200)}`,
            actions: [{ key: 'r', label: 'Retry', action: 'retry' }],
            canRetry: true,
          }
        }, managed.workspace.id)
      }
    } finally {
      // Clean up temporary agent
      if (isTemporary && agent) {
        agent.destroy()
      }
    }
  }

  private ensureUsageSummary(managed: ManagedSession): SessionUsage {
    if (!managed.usageSummary) {
      managed.usageSummary = createEmptySessionUsage(
        managed.id,
        managed.createdAt ?? managed.lastMessageAt ?? Date.now(),
      )
    }
    return managed.usageSummary
  }

  private resolveSessionProvider(managed: ManagedSession, usageModel?: string, usageProvider?: UsageProvider): UsageProvider {
    if (usageProvider) return usageProvider
    if (managed.llmProvider) return managed.llmProvider
    if (usageModel || managed.model) return inferProviderFromModel(usageModel ?? managed.model)
    return 'anthropic'
  }

  private applyUsageToSession(
    managed: ManagedSession,
    usage: AgentEventUsage,
  ): { provider: UsageProvider; model?: string; costUsd: number } {
    const summary = this.ensureUsageSummary(managed)
    const provider = this.resolveSessionProvider(managed, usage.model, usage.provider as UsageProvider | undefined)
    const model = usage.model ?? managed.model
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const cacheReadTokens = usage.cacheReadTokens ?? 0
    const costUsd = usage.costUsd ?? calculateTokenCostUsd({
      model,
      provider,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheReadTokens,
    })

    const providerUsage = summary.providers[provider] ?? createEmptyProviderUsage()
    providerUsage.callCount += 1
    providerUsage.inputTokens += inputTokens
    providerUsage.outputTokens += outputTokens
    providerUsage.estimatedCostUsd += costUsd
    summary.providers[provider] = providerUsage

    summary.totalCalls += 1
    summary.lastUpdatedAt = new Date().toISOString()

    // Keep session metadata in sync for future turns and persistence
    managed.llmProvider = provider
    if (model && !managed.model) {
      managed.model = model
    }

    return { provider, model, costUsd }
  }

  private updateLeadTeamUsageFromTeammate(teammate: ManagedSession): void {
    if (!teammate.parentSessionId || !teammate.teammateName) return
    const lead = this.sessions.get(teammate.parentSessionId)
    if (!lead) return

    const leadSummary = this.ensureUsageSummary(lead)
    const teamId = lead.teamId || teammate.teamId || teammate.parentSessionId
    const teammateIds = lead.teammateSessionIds || []

    const perTeammate: TeamSessionUsage['perTeammate'] = {}
    const perModel: TeamSessionUsage['perModel'] = {}
    let totalTeamCostUsd = 0

    for (const teammateId of teammateIds) {
      const teammateSession = this.sessions.get(teammateId)
      if (!teammateSession) continue

      const teammateSummary = teammateSession.usageSummary
      if (!teammateSummary) continue

      const provider = teammateSession.llmProvider ?? inferProviderFromModel(teammateSession.model)
      const inputTokens = Object.values(teammateSummary.providers).reduce((sum, p) => sum + p.inputTokens, 0)
      const outputTokens = Object.values(teammateSummary.providers).reduce((sum, p) => sum + p.outputTokens, 0)
      const costUsd = Object.values(teammateSummary.providers).reduce((sum, p) => sum + p.estimatedCostUsd, 0)
      const callCount = Object.values(teammateSummary.providers).reduce((sum, p) => sum + p.callCount, 0)
      const model = teammateSession.model || 'unknown'

      perTeammate[teammateId] = {
        name: teammateSession.teammateName || teammateSession.name || teammateId,
        model,
        provider,
        role: teammateSession.teammateName || 'teammate',
        inputTokens,
        outputTokens,
        costUsd,
        callCount,
      }

      if (!perModel[model]) {
        perModel[model] = { inputTokens: 0, outputTokens: 0, costUsd: 0, callCount: 0 }
      }
      perModel[model].inputTokens += inputTokens
      perModel[model].outputTokens += outputTokens
      perModel[model].costUsd += costUsd
      perModel[model].callCount += callCount

      totalTeamCostUsd += costUsd
    }

    leadSummary.teamUsage = {
      teamId,
      teammateCount: Object.keys(perTeammate).length,
      totalTeamCostUsd,
      perTeammate,
      perModel,
    }
    leadSummary.lastUpdatedAt = new Date().toISOString()
  }

  private processEvent(managed: ManagedSession, event: AgentEvent): void {
    const sessionId = managed.id
    const workspaceId = managed.workspace.id

    switch (event.type) {
      case 'text_delta':
        managed.streamingText += event.text
        // Hard cap streaming buffer to avoid OOM on long-running deltas
        const maxStreamingChars = 200_000
        if (managed.streamingText.length > maxStreamingChars) {
          managed.streamingText = managed.streamingText.slice(-maxStreamingChars)
        }
        // Queue delta for batched sending (performance: reduces IPC from 50+/sec to ~20/sec)
        this.queueDelta(sessionId, workspaceId, event.text, event.turnId)
        break

      case 'text_complete': {
        // Flush any pending deltas before sending complete (ensures renderer has all content)
        this.flushDelta(sessionId, workspaceId)

        // SDK's parent_tool_use_id identifies the subagent context for this text
        // (undefined = main agent / top-level, Task ID = inside subagent)
        // Only intermediate text (text before a tool_use) gets a parent assignment
        const textParentToolUseId = event.isIntermediate ? event.parentToolUseId : undefined

        const assistantMessage: Message = {
          id: generateMessageId(),
          role: 'assistant',
          content: event.text,
          timestamp: this.monotonic(),
          isIntermediate: event.isIntermediate,
          turnId: event.turnId,
          parentToolUseId: textParentToolUseId,
        }
        managed.messages.push(assistantMessage)

        // Prevent unbounded growth of intermediate messages (reasoning/debug streams)
        if (assistantMessage.isIntermediate) {
          const maxIntermediateMessages = 20
          const intermediateMessages = managed.messages.filter(m => m.isIntermediate)
          if (intermediateMessages.length > maxIntermediateMessages) {
            const toRemove = intermediateMessages.length - maxIntermediateMessages
            let removed = 0
            managed.messages = managed.messages.filter(m => {
              if (!m.isIntermediate) return true
              if (removed < toRemove) {
                removed += 1
                return false
              }
              return true
            })
          }
        }
        managed.streamingText = ''

        // Update lastMessageRole and lastFinalMessageId for badge/unread display (only for final messages)
        if (!event.isIntermediate) {
          managed.lastMessageRole = 'assistant'
          managed.lastFinalMessageId = assistantMessage.id
        }

        this.sendEvent({ type: 'text_complete', sessionId, text: event.text, isIntermediate: event.isIntermediate, turnId: event.turnId, parentToolUseId: textParentToolUseId }, workspaceId)

        // Persist session after complete message to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'tool_start': {
        // Format tool input paths to relative for better readability
        const formattedToolInput = formatToolInputPaths(event.input)

        // Resolve tool display metadata (icon, displayName) for skills/sources
        // Only resolve when we have input (second event for SDK dual-event pattern)
        const workspaceRootPath = managed.workspace.rootPath
        let toolDisplayMeta: ToolDisplayMeta | undefined
        if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
          const allSources = loadAllSources(workspaceRootPath)
          toolDisplayMeta = resolveToolDisplayMeta(event.toolName, formattedToolInput, workspaceRootPath, allSources)
        }

        // Check if a message with this toolUseId already exists FIRST
        // SDK sends two events per tool: first from stream_event (empty input),
        // second from assistant message (complete input)
        const existingStartMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        const isDuplicateEvent = !!existingStartMsg

        // Use parentToolUseId directly from the event — CraftAgent resolves this
        // from SDK's parent_tool_use_id (authoritative, handles parallel Tasks correctly).
        // No stack or map needed; the event carries the correct parent from the start.
        const parentToolUseId = event.parentToolUseId

        // Track if we need to send an event to the renderer
        // Send on: first occurrence OR when we have new input data to update
        let shouldSendEvent = !isDuplicateEvent

        if (existingStartMsg) {
          // Update existing message with complete input (second event has full input)
          if (formattedToolInput && Object.keys(formattedToolInput).length > 0) {
            const hadInputBefore = existingStartMsg.toolInput && Object.keys(existingStartMsg.toolInput).length > 0
            existingStartMsg.toolInput = formattedToolInput
            // Send update event if we're adding input that wasn't there before
            if (!hadInputBefore) {
              shouldSendEvent = true
            }
          }
          // Also set parent if not already set
          if (parentToolUseId && !existingStartMsg.parentToolUseId) {
            existingStartMsg.parentToolUseId = parentToolUseId
          }
          // Set toolDisplayMeta if not already set (has base64 icon for viewer)
          if (toolDisplayMeta && !existingStartMsg.toolDisplayMeta) {
            existingStartMsg.toolDisplayMeta = toolDisplayMeta
          }
          // Update toolIntent if not already set (second event has intent from complete input)
          if (event.intent && !existingStartMsg.toolIntent) {
            existingStartMsg.toolIntent = event.intent
          }
          // Update toolDisplayName if not already set
          if (event.displayName && !existingStartMsg.toolDisplayName) {
            existingStartMsg.toolDisplayName = event.displayName
          }
        } else {
          // Add tool message immediately (will be updated on tool_result)
          // This ensures tool calls are persisted even if they don't complete
          const toolStartMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: `Running ${event.toolName}...`,
            timestamp: this.monotonic(),
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput,
            toolStatus: 'executing',
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
          }
          managed.messages.push(toolStartMessage)
        }

        // Send event to renderer on first occurrence OR when input data is updated
        if (shouldSendEvent) {
          const timestamp = existingStartMsg?.timestamp ?? this.monotonic()
          this.sendEvent({
            type: 'tool_start',
            sessionId,
            toolName: event.toolName,
            toolUseId: event.toolUseId,
            toolInput: formattedToolInput ?? {},
            toolIntent: event.intent,
            toolDisplayName: event.displayName,
            toolDisplayMeta,  // Includes base64 icon for viewer compatibility
            turnId: event.turnId,
            parentToolUseId,
            timestamp,
          }, workspaceId)
        }
        break
      }

      case 'tool_result': {
        // toolName comes directly from CraftAgent (resolved via ToolIndex)
        const toolName = event.toolName || 'unknown'

        // Format absolute paths to relative paths for better readability
        const formattedResult = event.result ? formatPathsToRelative(event.result) : ''

        // Update existing tool message (created on tool_start) instead of creating new one
        const existingToolMsg = managed.messages.find(m => m.toolUseId === event.toolUseId)
        // Track if already completed to avoid sending duplicate events
        const wasAlreadyComplete = existingToolMsg?.toolStatus === 'completed'

        sessionLog.debug(`RESULT MATCH: toolUseId=${event.toolUseId}, found=${!!existingToolMsg}, toolName=${existingToolMsg?.toolName || toolName}, wasComplete=${wasAlreadyComplete}`)

        // parentToolUseId comes from CraftAgent (SDK-authoritative) or existing message
        const parentToolUseId = existingToolMsg?.parentToolUseId || event.parentToolUseId

        if (existingToolMsg) {
          existingToolMsg.content = formattedResult
          existingToolMsg.toolResult = formattedResult
          existingToolMsg.toolStatus = 'completed'
          existingToolMsg.isError = event.isError
          // If message doesn't have parent set, use event's parentToolUseId
          if (!existingToolMsg.parentToolUseId && event.parentToolUseId) {
            existingToolMsg.parentToolUseId = event.parentToolUseId
          }
        } else {
          // No matching tool_start found — create message from result.
          // This is normal for background subagent child tools where tool_result arrives
          // without a prior tool_start. If tool_start arrives later, findToolMessage will
          // locate this message by toolUseId and update it with input/intent/displayMeta.
          sessionLog.debug(`RESULT WITHOUT START: toolUseId=${event.toolUseId}, toolName=${toolName} (creating message from result)`)
          const fallbackWorkspaceRootPath = managed.workspace.rootPath
          const fallbackSources = loadAllSources(fallbackWorkspaceRootPath)
          const fallbackToolDisplayMeta = resolveToolDisplayMeta(toolName, undefined, fallbackWorkspaceRootPath, fallbackSources)

          const toolMessage: Message = {
            id: generateMessageId(),
            role: 'tool',
            content: formattedResult,
            timestamp: this.monotonic(),
            toolName: toolName,
            toolUseId: event.toolUseId,
            toolResult: formattedResult,
            toolStatus: 'completed',
            toolDisplayMeta: fallbackToolDisplayMeta,
            parentToolUseId,
            isError: event.isError,
          }
          managed.messages.push(toolMessage)
        }

        // Send event to renderer if: (a) first completion, or (b) result content changed
        // (e.g., safety net auto-completed with empty result, then real result arrived later)
        const resultChanged = wasAlreadyComplete && formattedResult && existingToolMsg?.toolResult !== formattedResult
        if (!wasAlreadyComplete || resultChanged) {
          this.sendEvent({
            type: 'tool_result',
            sessionId,
            toolUseId: event.toolUseId,
            toolName: toolName,
            result: formattedResult,
            turnId: event.turnId,
            parentToolUseId,
            isError: event.isError,
          }, workspaceId)
        }

        // Safety net: when a parent Task completes, mark all its still-pending child tools as completed.
        // This handles the case where child tool_result events never arrive (e.g., subagent internal tools
        // whose results aren't surfaced through the parent stream).
        const PARENT_TOOLS_FOR_CLEANUP = ['Task', 'TaskOutput']
        if (PARENT_TOOLS_FOR_CLEANUP.includes(toolName)) {
          const pendingChildren = managed.messages.filter(
            m => m.parentToolUseId === event.toolUseId
              && m.toolStatus !== 'completed'
              && m.toolStatus !== 'error'
          )
          for (const child of pendingChildren) {
            child.toolStatus = 'completed'
            child.toolResult = child.toolResult || ''
            sessionLog.debug(`CHILD AUTO-COMPLETED: toolUseId=${child.toolUseId}, toolName=${child.toolName} (parent ${toolName} completed)`)
            this.sendEvent({
              type: 'tool_result',
              sessionId,
              toolUseId: child.toolUseId!,
              toolName: child.toolName || 'unknown',
              result: child.toolResult || '',
              turnId: child.turnId,
              parentToolUseId: event.toolUseId,
            }, workspaceId)
          }
        }

        // Persist session after tool completes to prevent data loss on quit
        this.persistSession(managed)
        break
      }

      case 'status':
        this.sendEvent({
          type: 'status',
          sessionId,
          message: event.message,
          statusType: event.message.includes('Compacting') ? 'compacting' : undefined
        }, workspaceId)
        break

      case 'info': {
        const isCompactionComplete = event.message.startsWith('Compacted')

        // Persist compaction messages so they survive reload
        // Other info messages are transient (just sent to renderer)
        if (isCompactionComplete) {
          const compactionMessage: Message = {
            id: generateMessageId(),
            role: 'info',
            content: event.message,
            timestamp: this.monotonic(),
            statusType: 'compaction_complete',
          }
          managed.messages.push(compactionMessage)

          // Mark compaction complete in the session state.
          // This is done here (backend) rather than in the renderer so it's
          // not affected by CMD+R during compaction. The frontend reload
          // recovery will see awaitingCompaction=false and trigger execution.
          void markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
          sessionLog.info(`Session ${sessionId}: compaction complete, marked pending plan ready`)

          // Emit usage_update so the context count badge refreshes immediately
          // after compaction, without waiting for the next message
          if (managed.tokenUsage) {
            this.sendEvent({
              type: 'usage_update',
              sessionId,
              tokenUsage: {
                inputTokens: managed.tokenUsage.inputTokens,
                contextWindow: managed.tokenUsage.contextWindow,
              },
            }, workspaceId)
          }
        }

        this.sendEvent({
          type: 'info',
          sessionId,
          message: event.message,
          statusType: isCompactionComplete ? 'compaction_complete' : undefined
        }, workspaceId)
        break
      }

      case 'team_initialized': {
        // Agent teams: When the lead agent spawns a teammate
        const teamName = event.teamName
        // Implements REQ-003: Use clean team codename without ID prefix
        const teamDisplayName = buildTeamCodename(teamName)
        const teammateName = event.teammateName || 'Teammate'

        sessionLog.info(`Agent team initialized: ${teamName}, spawning ${teammateName}`)

        // Mark this session as a team lead
        managed.teamId = teamName
        managed.isTeamLead = true
        this.persistSession(managed)

        // Add an info message to the chat
        const initMessage: Message = {
          id: generateMessageId(),
          role: 'info',
          content: `Agent Team initializing: ${teamDisplayName}`,
          timestamp: Date.now(),
          infoLevel: 'info',
        }
        managed.messages.push(initMessage)

        // Send team initialization event to renderer
        this.sendEvent({
          type: 'team_initialized',
          sessionId,
          teamId: teamName,
          teammateName,
        }, workspaceId)

        this.startYoloIfConfigured(managed, teamName)

        break
      }

      case 'error':
        // Skip abort errors - these are expected when force-aborting via Query.close()
        if (event.message.includes('aborted') || event.message.includes('AbortError')) {
          sessionLog.info('Skipping abort error event (expected during interrupt)')
          break
        }

        const isConnectionLostError =
          event.message.includes('Connection to Codex lost') ||
          event.message.includes('Client disconnected')

        if (isConnectionLostError && !managed.connectionRetryAttempted && managed.lastSentMessage) {
          sessionLog.warn(`[reconnect-retry] Connection lost, attempting one automatic retry for session ${sessionId}`)
          managed.connectionRetryAttempted = true
          managed.connectionRetryInProgress = true

          // Mark not-processing so retry can start a fresh agent turn immediately.
          managed.isProcessing = false

          setImmediate(async () => {
            try {
              const retryMessage = managed.lastSentMessage
              const retryAttachments = managed.lastSentAttachments
              const retryStoredAttachments = managed.lastSentStoredAttachments
              const retryOptions = managed.lastSentOptions

              // Force fresh app-server process on retry
              this.destroyManagedAgent(managed, 'reconnect-retry')

              if (retryMessage) {
                // Remove the failed turn's user message to avoid duplication in transcript
                const lastUserMsgIndex = managed.messages.findLastIndex(m => m.role === 'user')
                if (lastUserMsgIndex !== -1) {
                  managed.messages.splice(lastUserMsgIndex, 1)
                }

                managed.connectionRetryInProgress = false
                await this.sendMessage(
                  sessionId,
                  retryMessage,
                  retryAttachments,
                  retryStoredAttachments,
                  retryOptions,
                  undefined,  // existingMessageId
                  false,      // _isAuthRetry
                  true        // _isReconnectRetry
                )
                sessionLog.info(`[reconnect-retry] Retry completed for session ${sessionId}`)
              } else {
                managed.connectionRetryInProgress = false
              }
            } catch (retryError) {
              managed.connectionRetryInProgress = false
              sessionLog.error(`[reconnect-retry] Retry failed for session ${sessionId}:`, retryError)
              Sentry.captureException(retryError, {
                tags: { errorSource: 'reconnect-retry', sessionId },
              })

              const failedMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: event.message,
                timestamp: Date.now(),
              }
              managed.messages.push(failedMessage)
              this.sendEvent({ type: 'error', sessionId, error: event.message }, workspaceId)
              this.onProcessingStopped(sessionId, 'error')
            }
          })

          // Skip immediate error rendering; retry path handles recovery/terminal error.
          break
        }

        // AgentEvent uses `message` not `error`
        const errorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          content: event.message,
          timestamp: this.monotonic()
        }
        managed.messages.push(errorMessage)
        this.sendEvent({ type: 'error', sessionId, error: event.message }, workspaceId)
        break

      case 'typed_error':
        // Skip abort errors - these are expected when force-aborting via Query.close()
        const typedErrorMsg = event.error.message || event.error.title || ''
        if (typedErrorMsg.includes('aborted') || typedErrorMsg.includes('AbortError')) {
          sessionLog.info('Skipping typed abort error event (expected during interrupt)')
          break
        }
        // Typed errors have structured information - send both formats for compatibility
        sessionLog.debug('typed_error:', JSON.stringify(event.error, null, 2))

        // Check for auth errors that can be retried by refreshing the token
        // The SDK subprocess caches the token at startup, so if it expires mid-session,
        // we get invalid_api_key errors. We can fix this by:
        // 1. Refreshing the token (reinitializeAuth)
        // 2. Destroying the agent (so it recreates with fresh token)
        // 3. Retrying the message
        const isAuthError = event.error.code === 'invalid_api_key' ||
          event.error.code === 'expired_oauth_token'

        if (isAuthError && !managed.authRetryAttempted && managed.lastSentMessage) {
          sessionLog.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`)
          managed.authRetryAttempted = true
          managed.authRetryInProgress = true

          // Trigger async retry (don't block the event processing)
          // We use setImmediate to let the current event loop finish
          setImmediate(async () => {
            try {
              // 1. Refresh auth (this will refresh the OAuth token if expired)
              // Pass the session's connection slug so we refresh the right credentials
              sessionLog.info(`[auth-retry] Refreshing auth for session ${sessionId}`)
              await this.reinitializeAuth(managed.llmConnection)

              // 2. Destroy the agent so it gets recreated with fresh token
              // The SDK subprocess has the old token cached in its env, so we must restart it
              sessionLog.info(`[auth-retry] Destroying agent for session ${sessionId}`)
              this.destroyManagedAgent(managed, 'auth-retry')

              // 3. Retry the message
              // Get the stored message/attachments before they're cleared
              const retryMessage = managed.lastSentMessage
              const retryAttachments = managed.lastSentAttachments
              const retryStoredAttachments = managed.lastSentStoredAttachments
              const retryOptions = managed.lastSentOptions

              if (retryMessage) {
                sessionLog.info(`[auth-retry] Retrying message for session ${sessionId}`)
                // Clear processing state so sendMessage can start fresh
                managed.isProcessing = false
                // Note: Don't clear lastSentMessage yet - sendMessage will set new ones

                // Remove the user message that was added for this failed attempt
                // so we don't get duplicate messages when retrying
                // Find and remove the last user message (the one we're retrying)
                const lastUserMsgIndex = managed.messages.findLastIndex(m => m.role === 'user')
                if (lastUserMsgIndex !== -1) {
                  managed.messages.splice(lastUserMsgIndex, 1)
                }

                // Clear authRetryInProgress before calling sendMessage
                // This allows the new request to be processed normally
                managed.authRetryInProgress = false

                await this.sendMessage(
                  sessionId,
                  retryMessage,
                  retryAttachments,
                  retryStoredAttachments,
                  retryOptions,
                  undefined,  // existingMessageId
                  true,       // _isAuthRetry - prevents infinite retry loop
                  false       // _isReconnectRetry
                )
                sessionLog.info(`[auth-retry] Retry completed for session ${sessionId}`)
              } else {
                managed.authRetryInProgress = false
              }
            } catch (retryError) {
              managed.authRetryInProgress = false
              sessionLog.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError)
              // Report auth retry failures to Sentry — indicates credential/SDK issues
              Sentry.captureException(retryError, {
                tags: { errorSource: 'auth-retry', sessionId },
              })
              // Show the original error to the user since retry failed
              const failedMessage: Message = {
                id: generateMessageId(),
                role: 'error',
                content: 'Authentication failed. Please check your credentials.',
                timestamp: this.monotonic(),
                errorCode: event.error.code,
              }
              managed.messages.push(failedMessage)
              this.sendEvent({
                type: 'typed_error',
                sessionId,
                error: event.error
              }, workspaceId)
              this.onProcessingStopped(sessionId, 'error')
            }
          })

          // Don't add error message or send to renderer - we're handling it via retry
          break
        }

        // Build rich error message with all diagnostic fields for persistence and UI display
        const typedErrorMessage: Message = {
          id: generateMessageId(),
          role: 'error',
          // Combine title and message for content display (handles undefined gracefully)
          content: [event.error.title, event.error.message].filter(Boolean).join(': ') || 'An error occurred',
          timestamp: this.monotonic(),
          // Rich error fields for diagnostics and retry functionality
          errorCode: event.error.code,
          errorTitle: event.error.title,
          errorDetails: event.error.details,
          errorOriginal: event.error.originalError,
          errorCanRetry: event.error.canRetry,
        }
        managed.messages.push(typedErrorMessage)
        // Send typed_error event with full structure for renderer to handle
        this.sendEvent({
          type: 'typed_error',
          sessionId,
          error: {
            code: event.error.code,
            title: event.error.title,
            message: event.error.message,
            actions: event.error.actions,
            canRetry: event.error.canRetry,
            details: event.error.details,
            originalError: event.error.originalError,
          }
        }, workspaceId)
        break

      case 'task_backgrounded':
      case 'task_progress':
        // Forward background task events directly to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'shell_backgrounded':
        // Store the command for later process killing
        if (event.command && managed) {
          managed.backgroundShellCommands.set(event.shellId, event.command)
          sessionLog.info(`Stored command for shell ${event.shellId}: ${event.command.slice(0, 50)}...`)
        }
        // Forward to renderer
        this.sendEvent({
          ...event,
          sessionId,
        }, workspaceId)
        break

      case 'source_activated':
        // A source was auto-activated mid-turn, forward to renderer for auto-retry
        sessionLog.info(`Source "${event.sourceSlug}" activated, notifying renderer for auto-retry`)
        this.sendEvent({
          type: 'source_activated',
          sessionId,
          sourceSlug: event.sourceSlug,
          originalMessage: event.originalMessage,
        }, workspaceId)
        break

      case 'todos_updated':
        // Codex turn plan updates - forward to renderer for TurnCard display
        this.sendEvent({
          type: 'todos_updated',
          sessionId,
          todos: event.todos,
          turnId: event.turnId,
          explanation: event.explanation ?? null,
        }, workspaceId)
        break

      case 'complete':
        // Complete event from CraftAgent - accumulate usage from this turn
        // Actual 'complete' sent to renderer comes from the finally block in sendMessage
        if (event.usage) {
          const applied = this.applyUsageToSession(managed, event.usage)

          // If this is a teammate session, fold usage into the lead session totals too
          if (managed.parentSessionId && managed.teammateName) {
            const lead = this.sessions.get(managed.parentSessionId)
            if (lead) {
              this.applyUsageToSession(lead, {
                ...event.usage,
                provider: applied.provider,
                model: applied.model,
                costUsd: applied.costUsd,
              })
              this.updateLeadTeamUsageFromTeammate(managed)
              this.persistSession(lead)
            }

            // Implements BUG-5: sync usage to teamManager so dashboard cost display works
            const resolvedTeamId = managed.teamId
              ? teamManager.resolveTeamId(managed.teamId)
              : managed.parentSessionId
                ? this.sessions.get(managed.parentSessionId)?.teamId
                  ? teamManager.resolveTeamId(this.sessions.get(managed.parentSessionId)!.teamId!)
                  : undefined
                : undefined
            if (resolvedTeamId) {
              teamManager.updateTeammateUsage(resolvedTeamId, managed.id, {
                inputTokens: event.usage.inputTokens,
                outputTokens: event.usage.outputTokens,
                costUsd: applied.costUsd,
              })
            }
          }

          // Initialize tokenUsage if not set
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // inputTokens = current context size (full conversation sent this turn), NOT accumulated
          // Each API call sends the full conversation history, so we use the latest value
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          // outputTokens and costUsd are accumulated across all turns (total session usage)
          managed.tokenUsage.outputTokens += event.usage.outputTokens
          managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          managed.tokenUsage.costUsd += applied.costUsd
          // Cache tokens reflect current state, not accumulated
          managed.tokenUsage.cacheReadTokens = event.usage.cacheReadTokens ?? 0
          managed.tokenUsage.cacheCreationTokens = event.usage.cacheCreationTokens ?? 0
          // Update context window (use latest value - may change if model switches)
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
        }
        break

      case 'usage_update':
        // Real-time usage update for context display during processing
        // Update managed session's tokenUsage with latest context size
        if (event.usage) {
          if (!managed.tokenUsage) {
            managed.tokenUsage = {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              contextTokens: 0,
              costUsd: 0,
            }
          }
          // Update only inputTokens (current context size) - other fields accumulate on complete
          managed.tokenUsage.inputTokens = event.usage.inputTokens
          if (event.usage.contextWindow) {
            managed.tokenUsage.contextWindow = event.usage.contextWindow
          }
          // Some providers (Codex) include running output/cost estimates in usage_update.
          // We keep display totals monotonic for UI feedback but finalize true totals on complete.
          if (event.usage.outputTokens !== undefined) {
            managed.tokenUsage.outputTokens = Math.max(managed.tokenUsage.outputTokens, event.usage.outputTokens)
            managed.tokenUsage.totalTokens = managed.tokenUsage.inputTokens + managed.tokenUsage.outputTokens
          }
          if (event.usage.costUsd !== undefined) {
            managed.tokenUsage.costUsd = Math.max(managed.tokenUsage.costUsd, event.usage.costUsd)
          }

          // Send to renderer for immediate UI update
          this.sendEvent({
            type: 'usage_update',
            sessionId: managed.id,
            tokenUsage: {
              inputTokens: event.usage.inputTokens,
              contextWindow: event.usage.contextWindow,
            },
          }, workspaceId)
        }
        break

      // Note: working_directory_changed is user-initiated only (via updateWorkingDirectory),
      // the agent no longer has a change_working_directory tool
    }

    // Hard cap in-memory message list to prevent unbounded growth
    const maxInMemoryMessages = 1000
    if (managed.messages.length > maxInMemoryMessages) {
      managed.messages = managed.messages.slice(-maxInMemoryMessages)
    }
  }

  private updateTeammateTasks(
    teamId: string,
    teammateId: string,
    status: 'completed' | 'failed'
  ): void {
    const tasks = teamManager.getTasks(teamId)
    tasks
      .filter(task => task.assignee === teammateId && task.status === 'in_progress')
      .forEach(task => teamManager.updateTaskStatus(teamId, task.id, status))
  }

  private sendEvent(event: SessionEvent, workspaceId?: string): void {
    if (!this.windowManager) {
      sessionLog.warn('Cannot send event - no window manager')
      return
    }

    // Broadcast to ALL windows for this workspace (main + tab content windows)
    const windows = workspaceId
      ? this.windowManager.getAllWindowsForWorkspace(workspaceId)
      : []

    if (windows.length === 0) {
      sessionLog.warn(`Cannot send ${event.type} event - no windows for workspace ${workspaceId}`)
      return
    }

    // Send event to all windows for this workspace
    for (const window of windows) {
      // Check mainFrame - it becomes null when render frame is disposed
      // This prevents Electron's internal error logging before our try-catch
      if (!window.isDestroyed() &&
          !window.webContents.isDestroyed() &&
          window.webContents.mainFrame) {
        try {
          window.webContents.send(IPC_CHANNELS.SESSION_EVENT, event)
        } catch {
          // Silently ignore - expected during window closure race conditions
        }
      }
    }
  }

  /**
   * Queue a text delta for batched sending (performance optimization)
   * Instead of sending 50+ IPC events per second, batches deltas and flushes every 50ms
   */
  private queueDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      // Append to existing batch
      existing.delta += delta
      // Keep the latest turnId (should be the same, but just in case)
      if (turnId) existing.turnId = turnId
    } else {
      // Start new batch
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    // Schedule flush if not already scheduled
    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushDelta(sessionId, workspaceId)
      }, DELTA_BATCH_INTERVAL_MS)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  /**
   * Flush any pending deltas for a session (sends batched IPC event)
   * Called on timer or when streaming ends (text_complete)
   */
  private flushDelta(sessionId: string, workspaceId: string): void {
    // Clear the timer
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    // Send batched delta if any
    const pending = this.pendingDeltas.get(sessionId)
    if (pending && pending.delta) {
      this.sendEvent({
        type: 'text_delta',
        sessionId,
        delta: pending.delta,
        turnId: pending.turnId
      }, workspaceId)
      this.pendingDeltas.delete(sessionId)
    }
  }

  /**
   * Execute a prompt hook by creating a new session and sending the prompt
   */
  private async executePromptHook(
    workspaceId: string,
    workspaceRootPath: string,
    prompt: string,
    labels?: string[],
    permissionMode?: 'safe' | 'ask' | 'allow-all',
    mentions?: string[],
  ): Promise<{ sessionId: string }> {
    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? this.resolveHookMentions(workspaceRootPath, mentions) : undefined

    // Create a new session for this hook
    const session = await this.createSession(workspaceId, {
      name: `Hook: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`,
      labels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
    })

    // Send the prompt
    await this.sendMessage(session.id, prompt)

    return { sessionId: session.id }
  }

  /**
   * Resolve @mentions in hook prompts to source and skill slugs
   */
  private resolveHookMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadWorkspaceSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        sessionLog.warn(`[Hooks] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  /**
   * Clean up all resources held by the SessionManager.
   * Should be called on app shutdown to prevent resource leaks.
   */
  cleanup(): void {
    sessionLog.info('Cleaning up resources...')

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      sessionLog.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Stop all compliance watchers
    for (const [sessionId, watcher] of this.complianceWatchers) {
      watcher.close()
      sessionLog.info(`Stopped compliance watcher for ${sessionId}`)
    }
    this.complianceWatchers.clear()
    for (const [sessionId, timer] of this.complianceSyncTimers) {
      clearTimeout(timer)
    }
    this.complianceSyncTimers.clear()
    // Dispose all HookSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, hookSystem] of this.hookSystems) {
      try {
        hookSystem.dispose()
        sessionLog.info(`Disposed HookSystem for ${workspacePath}`)
      } catch (error) {
        sessionLog.error(`Failed to dispose HookSystem for ${workspacePath}:`, error)
      }
    }
    this.hookSystems.clear()

    // Clear all pending delta flush timers
    for (const [sessionId, timer] of this.deltaFlushTimers) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()
    for (const timer of this.teammateKickoffTimers.values()) {
      clearTimeout(timer)
    }
    this.teammateKickoffTimers.clear()

    // Clear pending credential resolvers (they won't be resolved, but prevents memory leak)
    this.pendingCredentialResolvers.clear()

    // Dispose all live agents and clean session-scoped callbacks
    for (const managed of this.sessions.values()) {
      if (managed.agent) {
        this.destroyManagedAgent(managed, 'sessionManager.cleanup')
      } else {
        unregisterSessionScopedToolCallbacks(managed.id)
      }
    }

    // Stop health monitoring and remove handlers
    for (const teamId of Array.from(this.healthMonitorTeams)) {
      this.stopTeamHealthMonitoring(teamId)
    }
    this.healthMonitor.dispose()
    this.teamHealthAlertHandlers.clear()

    sessionLog.info('Cleanup complete')
  }
}
