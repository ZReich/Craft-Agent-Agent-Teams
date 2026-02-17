import { sessionLog } from './logger'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { mergeQualityGateConfig, inferTaskType, shouldSkipQualityGates } from '@craft-agent/shared/agent-teams/quality-gates'
import { applyLearningGuidanceToQualityConfig, getLearningGuidance, recordQualityLearning } from '@craft-agent/shared/agent-teams/learning-store'
import { type QualityGateConfig, type QualityGateResult } from '@craft-agent/core/types'
import { DiffCollector } from '@craft-agent/shared/agent-teams/diff-collector'
import { formatFailureReport, formatSuccessReport, type QualityGateRunner, type TaskContext } from './quality-gate-runner'

type StopReason = 'complete' | 'interrupted' | 'error' | 'timeout'

export type ReviewerQaVerdict = 'pass' | 'fail' | 'unknown'

// Implements REQ-QA-001: explicit reviewer PASS/FAIL gate before lead synthesis.
const QA_FAIL_PATTERNS: RegExp[] = [
  /\bFAIL(?:ED|URE|ING)?\b/i,
  /\bDID\s+NOT\s+PASS\b/i,
  /\bBLOCKER(?:S)?\b/i,
  /\bCANNOT\s+APPROVE\b/i,
]

const QA_PASS_PATTERNS: RegExp[] = [
  /\bPASS(?:ED)?\b/i,
  /\bAPPROVED\b/i,
  /\bLGTM\b/i,
]

export function inferReviewerQaVerdict(content?: string): ReviewerQaVerdict {
  const text = content?.trim()
  if (!text) return 'unknown'

  const hasFail = QA_FAIL_PATTERNS.some(pattern => pattern.test(text))
  if (hasFail) return 'fail'

  const hasPass = QA_PASS_PATTERNS.some(pattern => pattern.test(text))
  if (hasPass) return 'pass'

  return 'unknown'
}

function isReviewerSessionCandidate(session: ManagedSessionLike): boolean {
  if (session.teammateRole === 'reviewer') return true
  const name = (session.teammateName ?? '').toLowerCase()
  return /\breviewer\b|\bqa\b/.test(name)
}

type ManagedSessionIdentity = {
  id: string
  name?: string
  teamId?: string
  parentSessionId?: string
  teammateName?: string
  teammateRole?: string
  teammateSessionIds?: string[]
  workingDirectory?: string
  workspace: { rootPath: string }
  messages: Array<{ role: string; isIntermediate?: boolean; content?: string }>
  agent?: unknown
}

type ManagedSessionExecutionState = {
  isTeamLead?: boolean
  isProcessing?: boolean
  teamLevelQgRunning?: boolean
  qgCycleCount?: number
  lastMessageAt?: number
}

type ManagedSessionReviewArtifacts = {
  speculativeReviewDiff?: Awaited<ReturnType<typeof DiffCollector.collectWorkingDiff>> | null
  speculativeReviewFingerprint?: string
  speculativeReviewCapturedAt?: number
}

type ManagedSessionGuardFlags = {
  /** Guard: teammate results already relayed to lead — prevents duplicate deliveries */
  completionRelayed?: boolean
  /** Guard: synthesis prompt already sent to this lead — prevents duplicate prompts */
  synthesisPromptSent?: boolean
  /** Reviewer QA verdict used by explicit synthesis gate */
  qaVerdict?: ReviewerQaVerdict
  /** Guard: QA gate block notification already sent */
  qaGateBlockedNotified?: boolean
}

type ManagedSessionLike =
  & ManagedSessionIdentity
  & ManagedSessionExecutionState
  & ManagedSessionReviewArtifacts
  & ManagedSessionGuardFlags

export type AgentTeamCompletionContext = {
  sessions: {
    getById: (sessionId: string) => ManagedSessionLike | undefined
  }
  teammate: {
    updateTaskStatus: (teamId: string, sessionId: string, status: 'completed' | 'failed') => void
    autoArchiveCompletedSession: (sessionId: string) => Promise<void>
    getQualityGateSkipReason: (managed: ManagedSessionLike) => string | null
    disposeAgent: (sessionId: string, reason: string) => void
  }
  messaging: {
    sendToSession: (sessionId: string, message: string) => Promise<void>
    clearLeadTeamState: (lead: ManagedSessionLike) => void
    buildTeamDeliveryMetadata: (options: { outputPresent: boolean; receiverId?: string }) => string
  }
  quality: {
    getRunner: () => QualityGateRunner
    cycles: Map<string, number>
    resolveReviewInput: (reviewDiff: Awaited<ReturnType<typeof DiffCollector.collectWorkingDiff>> | null) => { usesGitDiff: boolean; reviewInput: string; failureReason: string | undefined }
    buildLeadSummary: (teammateName: string, result: QualityGateResult, outcome: 'passed' | 'failed' | 'escalated') => string
    buildWorkerFeedback: (result: QualityGateResult, maxCycles: number) => string
    formatPercentScore: (score: number) => string
  }
  team: {
    resolveTeamId: (teamId: string) => string
    getTeamSpec: (teamId: string) => ReturnType<typeof import('@craft-agent/shared/agent/agent-team-manager').teamManager.getTeamSpec>
    storeQualityResult: (teamId: string, sessionId: string, result: any) => void
    logActivity: (
      teamId: string,
      action: Parameters<typeof import('@craft-agent/shared/agent/agent-team-manager').teamManager.logActivity>[1],
      message: string,
      sessionId?: string,
      teammateName?: string
    ) => void
    /** Stop health monitoring + status check-in polling for a team. Optional for backwards compat. */
    stopHealthMonitoring?: (teamId: string) => void
  }
}

type TeamQgQueueItem = {
  fn: () => Promise<void>
  resolve: () => void
}

type TeamQgQueueState = {
  active: number
  queue: TeamQgQueueItem[]
}

export class AgentTeamCompletionCoordinator {
  // Implements REQ-NEXT-005: bounded parallel quality-gate slots per team.
  private teamQgQueueState = new Map<string, TeamQgQueueState>()

  constructor(private readonly context: AgentTeamCompletionContext) {}

  async handleAgentTeamCompletionOnStop(managed: ManagedSessionLike, sessionId: string, reason: StopReason): Promise<void> {
    if (reason !== 'complete' || !managed.parentSessionId || !managed.teammateName) return

    // Guard: skip if this teammate's completion was already relayed to the lead.
    // This covers two cases:
    // 1. Teammate with subagents triggers onProcessingStopped multiple times (once per subagent)
    // 2. Teammate sent results via SendMessage DM — relay already happened in the DM handler
    // In case 2, we still need to update task status and check if the lead should synthesize.
    if (managed.completionRelayed) {
      sessionLog.info(`[AgentTeams] Skipping duplicate completion relay for "${managed.teammateName}" (${sessionId}) — already relayed`)
      const lead = this.context.sessions.getById(managed.parentSessionId)
      if (lead?.isTeamLead) {
        // Still update task status and check synthesis even when skipping relay
        const resolvedTeamId = this.context.team.resolveTeamId(managed.teamId ?? managed.parentSessionId)
        this.context.teammate.updateTaskStatus(resolvedTeamId, managed.id, 'completed')
        await this.maybePromptLeadSynthesis(lead, managed.parentSessionId)
      }
      return
    }

    const lead = this.context.sessions.getById(managed.parentSessionId)
    if (!lead || !lead.isTeamLead) return

    // Mark before async work to prevent races from concurrent stop events
    managed.completionRelayed = true

    const lastAssistantMsg = [...managed.messages].reverse().find(m => m.role === 'assistant' && !m.isIntermediate)
    const outputPresent = Boolean(lastAssistantMsg?.content?.trim())
    const resultContent = outputPresent
      ? (lastAssistantMsg?.content ?? '')
      : `*${managed.teammateName || 'Teammate'} sent results via direct message to the lead. Check the lead session for the full report.*`

    if (isReviewerSessionCandidate(managed)) {
      managed.qaVerdict = inferReviewerQaVerdict(lastAssistantMsg?.content ?? resultContent)
    }

    const teammateName = managed.teammateName
    const resolvedTeamId = this.context.team.resolveTeamId(managed.teamId ?? managed.parentSessionId)
    const deliveryMeta = this.context.messaging.buildTeamDeliveryMetadata({ outputPresent, receiverId: managed.parentSessionId })
    const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const baseQgConfig = mergeQualityGateConfig(wsConfig?.agentTeams?.qualityGates as Partial<QualityGateConfig> | undefined)
    const learningGuidance = getLearningGuidance(managed.workspace.rootPath)
    const qgConfig = applyLearningGuidanceToQualityConfig(baseQgConfig, learningGuidance)
    if (learningGuidance.tightenErrorBypass) {
      this.context.team.logActivity(
        resolvedTeamId,
        'phase-advanced',
        `[Learning] Tightened quality-gate bypass boundaries for this run (${learningGuidance.rationale.join('; ')})`,
        managed.id,
        teammateName,
      )
    }

    if (!qgConfig.enabled) {
      this.context.teammate.updateTaskStatus(resolvedTeamId, managed.id, 'completed')
      await this.relayTeammateMessages(managed.parentSessionId, teammateName, resultContent, deliveryMeta)
      await this.maybePromptLeadSynthesis(lead, managed.parentSessionId)
      return
    }

    const skipReason = this.context.teammate.getQualityGateSkipReason(managed)
    if (skipReason) {
      sessionLog.info(`[AgentTeams] Relaying results from teammate "${teammateName}" (QG skipped: ${skipReason})`)
      this.context.teammate.updateTaskStatus(resolvedTeamId, managed.id, 'completed')
      await this.relayTeammateMessages(managed.parentSessionId, teammateName, resultContent, deliveryMeta)
      await this.runTeamLevelQualityGate(lead, managed, qgConfig, resolvedTeamId)
      return
    }

    // REQ-NEXT-005: queue per team with bounded parallel slots.
    const maxParallel = Math.max(1, Math.min(6, qgConfig.maxParallelReviews ?? 2))
    await this.enqueueQualityGate(resolvedTeamId, () => this.runIndividualQualityGates({
      managed,
      lead,
      teammateName,
      resolvedTeamId,
      resultContent,
      deliveryMeta,
      qgConfig,
      sessionId,
    }), maxParallel)
  }

  private async enqueueQualityGate(teamId: string, fn: () => Promise<void>, maxParallel: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const state = this.teamQgQueueState.get(teamId) ?? { active: 0, queue: [] }
      state.queue.push({ fn, resolve })
      this.teamQgQueueState.set(teamId, state)
      this.drainQualityGateQueue(teamId, maxParallel)
    })
  }

  private drainQualityGateQueue(teamId: string, maxParallel: number): void {
    const state = this.teamQgQueueState.get(teamId)
    if (!state) return

    while (state.active < maxParallel && state.queue.length > 0) {
      const next = state.queue.shift()!
      state.active += 1

      void next.fn()
        .catch((err) => {
          sessionLog.error(`[AgentTeams] Quality gate worker failed for team ${teamId}:`, err)
        })
        .finally(() => {
          state.active = Math.max(0, state.active - 1)
          next.resolve()
          if (state.active === 0 && state.queue.length === 0) {
            this.teamQgQueueState.delete(teamId)
            return
          }
          this.drainQualityGateQueue(teamId, maxParallel)
        })
    }
  }

  private async relayTeammateMessages(parentSessionId: string, teammateName: string, resultContent: string, deliveryMeta: string, template = '**{name}** completed:'): Promise<void> {
    const relayMessage = [
      template.replace('{name}', teammateName),
      '',
      '---',
      '',
      resultContent,
      '',
      deliveryMeta,
    ].join('\n')
    await this.context.messaging.sendToSession(parentSessionId, relayMessage)
  }

  private async maybeArchiveCompletedTeamSession(sessionId: string): Promise<void> {
    try {
      await this.context.teammate.autoArchiveCompletedSession(sessionId)
    } catch (err) {
      sessionLog.error('[AgentTeams] Failed to auto-archive teammate session:', err)
    }
  }

  private buildReviewFingerprint(reviewDiff: Awaited<ReturnType<typeof DiffCollector.collectWorkingDiff>> | null): string {
    if (!reviewDiff) return 'none'
    const payload = reviewDiff.unifiedDiff || ''
    return `${payload.length}:${payload.slice(0, 120)}:${payload.slice(-120)}`
  }

  private async maybePromptLeadSynthesis(lead: ManagedSessionLike, parentSessionId: string): Promise<void> {
    // Guard: only send the synthesis prompt once per team lifecycle.
    // Multiple teammates completing in quick succession can each trigger this check,
    // but the lead should only receive one synthesis prompt.
    if (lead.synthesisPromptSent) return

    const allDone = (lead.teammateSessionIds || []).every(tid => {
      const teammate = this.context.sessions.getById(tid)
      return teammate && !teammate.isProcessing
    })

    if (allDone && !lead.teamLevelQgRunning) {
      if (!(await this.enforceReviewerQaGate(lead, parentSessionId))) {
        return
      }
      lead.synthesisPromptSent = true  // Mark before sending to prevent races
      this.context.messaging.clearLeadTeamState(lead)
      // Stop health monitoring — all teammates are done, no more check-ins needed
      this.context.team.stopHealthMonitoring?.(lead.teamId ?? parentSessionId)
      await this.context.messaging.sendToSession(parentSessionId, '[System] All teammates have completed their work. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
    }
  }

  private async runTeamLevelQualityGate(lead: ManagedSessionLike, managed: ManagedSessionLike, qgConfig: QualityGateConfig, resolvedTeamId: string): Promise<void> {
    const allDone = (lead.teammateSessionIds || []).every(tid => {
      const teammate = this.context.sessions.getById(tid)
      return teammate && !teammate.isProcessing
    })
    if (!allDone || lead.teamLevelQgRunning) return

    // Guard: don't send duplicate synthesis prompts via the team-level QG path either
    if (lead.synthesisPromptSent) return

    const allTaskTypes = (lead.teammateSessionIds || []).map(tid => {
      const t = this.context.sessions.getById(tid)
      return inferTaskType(t?.name || '')
    })
    const allNonCode = allTaskTypes.every(t => t != null && shouldSkipQualityGates(t))
    if (allNonCode) {
      if (!(await this.enforceReviewerQaGate(lead, managed.parentSessionId!))) {
        return
      }
      lead.synthesisPromptSent = true
      this.context.messaging.clearLeadTeamState(lead)
      this.context.team.stopHealthMonitoring?.(lead.teamId ?? managed.parentSessionId!)
      await this.context.messaging.sendToSession(managed.parentSessionId!, '[System] All teammates have completed their work. Please review the results and synthesize a final response for the user.')
      return
    }

    lead.teamLevelQgRunning = true
    try {
      const runner = this.context.quality.getRunner()
      const teamDiff = managed.workingDirectory ? await DiffCollector.collectWorkingDiff(managed.workingDirectory) : null
      const teamReviewInput = this.context.quality.resolveReviewInput(teamDiff)

      if (!teamReviewInput.usesGitDiff) {
        if (!(await this.enforceReviewerQaGate(lead, managed.parentSessionId!))) {
          return
        }
        this.context.messaging.clearLeadTeamState(lead)
        await this.context.messaging.sendToSession(managed.parentSessionId!, '[System] All teammates have completed their work. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
        return
      }

      const spec = managed.teamId ? this.context.team.getTeamSpec(this.context.team.resolveTeamId(managed.teamId)) : undefined
      const taskContext: TaskContext = { taskDescription: lead.name || 'Team integration check', workingDirectory: managed.workingDirectory }
      const result = await runner.runProgressive(teamReviewInput.reviewInput, taskContext, qgConfig, spec)
      this.context.team.storeQualityResult(resolvedTeamId, managed.parentSessionId!, result)
      recordQualityLearning(managed.workspace.rootPath, result)

      if (result.passed) {
        if (!(await this.enforceReviewerQaGate(lead, managed.parentSessionId!))) {
          return
        }
        this.context.messaging.clearLeadTeamState(lead)
        await this.context.messaging.sendToSession(managed.parentSessionId!, [`<details><summary>Quality Gate — PASSED (${result.aggregateScore}%)</summary>`, '', formatSuccessReport(result), '', '</details>', '', '[System] All teammates have completed their work and the team-level quality gate has passed. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.'].join('\n'))
      } else {
        await this.context.messaging.sendToSession(managed.parentSessionId!, [`<details open><summary>Quality Gate — FAILED (${result.aggregateScore}%)</summary>`, '', formatFailureReport(result, qgConfig), '', '</details>', '', '[System] All teammates have completed, but the team-level quality gate did not pass. Review the issues above and decide how to address them — you may need to spawn additional Heads or fix issues directly.'].join('\n'))
      }
    } catch (err) {
      if (!(await this.enforceReviewerQaGate(lead, managed.parentSessionId!))) {
        return
      }
      this.context.messaging.clearLeadTeamState(lead)
      await this.context.messaging.sendToSession(managed.parentSessionId!, '[System] All teammates have completed their work (team quality gate skipped due to error). Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
      sessionLog.error('[AgentTeams] Team-level quality gate error:', err)
    } finally {
      lead.teamLevelQgRunning = false
    }
  }

  private evaluateReviewerQaGate(lead: ManagedSessionLike): { passed: boolean; reason?: string } {
    const reviewerSessions = (lead.teammateSessionIds || [])
      .map(tid => this.context.sessions.getById(tid))
      .filter((session): session is ManagedSessionLike => Boolean(session))
      .filter(isReviewerSessionCandidate)

    if (reviewerSessions.length === 0) {
      return { passed: true }
    }

    // Use the latest reviewer verdict as the explicit QA gate signal.
    const latestReviewer = reviewerSessions
      .slice()
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))[0]!

    const lastAssistantMsg = [...latestReviewer.messages]
      .reverse()
      .find(m => m.role === 'assistant' && !m.isIntermediate)

    const verdict = latestReviewer.qaVerdict ?? inferReviewerQaVerdict(lastAssistantMsg?.content ?? '')
    if (verdict === 'pass') {
      return { passed: true }
    }

    if (verdict === 'fail') {
      return {
        passed: false,
        reason: `Reviewer "${latestReviewer.teammateName || latestReviewer.id}" reported FAIL. QA PASS is required before synthesis.`,
      }
    }

    return {
      passed: false,
      reason: `Reviewer "${latestReviewer.teammateName || latestReviewer.id}" did not provide an explicit PASS signal.`,
    }
  }

  private async enforceReviewerQaGate(lead: ManagedSessionLike, parentSessionId: string): Promise<boolean> {
    // Implements REQ-QA-001: synthesis is blocked until the latest reviewer signals PASS.
    const qaGate = this.evaluateReviewerQaGate(lead)
    if (qaGate.passed) {
      lead.qaGateBlockedNotified = false
      return true
    }

    if (!lead.qaGateBlockedNotified) {
      lead.qaGateBlockedNotified = true
      await this.context.messaging.sendToSession(
        parentSessionId,
        [
          '[System] QA gate is blocking final synthesis.',
          qaGate.reason ?? 'A reviewer PASS signal is required before synthesis.',
          'Resolve reviewer findings (or re-run QA) and ensure the latest reviewer report explicitly says PASS.',
        ].join('\n'),
      )
    }

    return false
  }

  private async runIndividualQualityGates(params: {
    managed: ManagedSessionLike
    lead: ManagedSessionLike
    teammateName: string
    resolvedTeamId: string
    resultContent: string
    deliveryMeta: string
    qgConfig: QualityGateConfig
    sessionId: string
  }): Promise<void> {
    const { managed, lead, teammateName, resolvedTeamId, resultContent, deliveryMeta, qgConfig, sessionId } = params
    const cycleKey = `${sessionId}-qg`
    // Use persisted cycle count (survives app restarts) with in-memory Map as fallback
    const previousCycle = managed.qgCycleCount ?? this.context.quality.cycles.get(cycleKey) ?? 0
    const currentCycle = previousCycle + 1
    managed.qgCycleCount = currentCycle
    this.context.quality.cycles.set(cycleKey, currentCycle)

    // HARD CAP: Absolutely no more QG cycles after maxReviewCycles + 1 (post-escalation attempt)
    const absoluteMax = qgConfig.maxReviewCycles + 1
    if (currentCycle > absoluteMax) {
      sessionLog.warn(`[AgentTeams] QG hard cap reached for "${teammateName}" (cycle ${currentCycle} > ${absoluteMax}). Force-relaying results.`)
      this.context.quality.cycles.delete(cycleKey)
      this.context.teammate.updateTaskStatus(resolvedTeamId, managed.id, 'completed')
      await this.relayTeammateMessages(managed.parentSessionId!, teammateName, resultContent, deliveryMeta)
      await this.maybeArchiveCompletedTeamSession(sessionId)
      await this.maybePromptLeadSynthesis(lead, managed.parentSessionId!)
      return
    }

    const runner = this.context.quality.getRunner()
    const taskContext: TaskContext = { taskDescription: managed.name || 'Teammate task', workingDirectory: managed.workingDirectory }

    try {
      const spec = managed.teamId ? this.context.team.getTeamSpec(this.context.team.resolveTeamId(managed.teamId)) : undefined
      const speculativeAgeMs = managed.speculativeReviewCapturedAt ? Date.now() - managed.speculativeReviewCapturedAt : Number.POSITIVE_INFINITY
      const useSpeculative = Boolean(managed.speculativeReviewDiff && speculativeAgeMs <= 2 * 60 * 1000)
      let reviewDiff = useSpeculative
        ? managed.speculativeReviewDiff ?? null
        : (managed.workingDirectory ? await DiffCollector.collectWorkingDiff(managed.workingDirectory) : null)
      let reviewInput = this.context.quality.resolveReviewInput(reviewDiff)

      // REQ-NEXT-008: If speculative artifact is stale/mismatched, fall back safely to fresh diff.
      if (useSpeculative && managed.speculativeReviewFingerprint && reviewDiff) {
        const currentFingerprint = this.buildReviewFingerprint(reviewDiff)
        if (currentFingerprint !== managed.speculativeReviewFingerprint && managed.workingDirectory) {
          sessionLog.info(`[SpeculativeQG] Fingerprint mismatch for ${sessionId}; falling back to fresh diff`)
          reviewDiff = await DiffCollector.collectWorkingDiff(managed.workingDirectory)
          reviewInput = this.context.quality.resolveReviewInput(reviewDiff)
        }
      }
      if (useSpeculative && !reviewInput.usesGitDiff && managed.workingDirectory) {
        reviewDiff = await DiffCollector.collectWorkingDiff(managed.workingDirectory)
        reviewInput = this.context.quality.resolveReviewInput(reviewDiff)
      }
      if (useSpeculative) {
        sessionLog.info(`[SpeculativeQG] ${reviewInput.usesGitDiff ? 'Reused' : 'Skipped'} speculative artifact for ${teammateName}`)
      }
      managed.speculativeReviewDiff = null
      managed.speculativeReviewFingerprint = undefined
      managed.speculativeReviewCapturedAt = undefined

      if (!reviewInput.usesGitDiff) {
        if (currentCycle >= qgConfig.maxReviewCycles) {
          this.context.quality.cycles.delete(cycleKey)
          await this.relayTeammateMessages(managed.parentSessionId!, teammateName, ['**Quality Gate Escalated**', `Cycle: ${currentCycle}/${qgConfig.maxReviewCycles}`, `Reason: ${reviewInput.failureReason}`, '', 'Action required: ensure teammate changes are present in the git working tree before re-running quality gates.', '', resultContent].join('\n'), deliveryMeta)
          await this.maybeArchiveCompletedTeamSession(sessionId)
          return
        }

        await this.context.messaging.sendToSession(sessionId, ['## Quality Gate Feedback', `Cycle ${currentCycle}/${qgConfig.maxReviewCycles}`, '', 'Your work did not pass quality checks.', '', `Blocking issue: ${reviewInput.failureReason}`, '', 'Please make sure implementation changes are written to files in the working directory, then try again.'].join('\n'))
        return
      }

      const result = await runner.runProgressive(reviewInput.reviewInput, taskContext, qgConfig, spec)
      result.cycleCount = currentCycle
      result.maxCycles = qgConfig.maxReviewCycles
      this.context.team.storeQualityResult(resolvedTeamId, managed.id, result)
      recordQualityLearning(managed.workspace.rootPath, result)

      if (result.passed) {
        this.context.quality.cycles.delete(cycleKey)
        this.context.team.logActivity(resolvedTeamId, 'quality-gate-passed', `Quality gate passed at ${this.context.quality.formatPercentScore(result.aggregateScore)}`, managed.id, teammateName)
        this.context.teammate.updateTaskStatus(resolvedTeamId, managed.id, 'completed')

        const relayMessage = [
          `**${teammateName}** completed:`,
          '',
          '---',
          '',
          this.context.quality.buildLeadSummary(teammateName, result, 'passed'),
          '',
          `<details><summary>Quality Gate — PASSED (${result.aggregateScore}%)</summary>`,
          '',
          formatSuccessReport(result),
          '',
          '</details>',
          '',
          resultContent,
          '',
          deliveryMeta,
        ].join('\n')

        await this.context.messaging.sendToSession(managed.parentSessionId!, relayMessage)
        // Free memory: dispose the teammate's agent subprocess now that QG passed
        this.context.teammate.disposeAgent(sessionId, 'qg-passed')
        await this.maybeArchiveCompletedTeamSession(sessionId)
        await this.maybePromptLeadSynthesis(lead, managed.parentSessionId!)
        return
      }

      if (currentCycle >= qgConfig.maxReviewCycles) {
        this.context.quality.cycles.delete(cycleKey)
        let escalationNote = ''
        try {
          escalationNote = await runner.escalate(result, resultContent, taskContext, qgConfig)
          result.escalatedTo = qgConfig.escalationModel
        } catch (err) {
          escalationNote = 'Escalation failed — manual review required.'
          sessionLog.error('[AgentTeams] Escalation failed:', err)
        }

        this.context.team.logActivity(resolvedTeamId, 'escalation', `Quality gate escalated at ${this.context.quality.formatPercentScore(result.aggregateScore)} after ${currentCycle} cycles`, managed.id, teammateName)
        await this.context.messaging.sendToSession(managed.parentSessionId!, [
          `**${teammateName}** completed:`,
          '',
          '---',
          '',
          this.context.quality.buildLeadSummary(teammateName, result, 'escalated'),
          '',
          `<details open><summary>Quality Gate — ESCALATED (${result.aggregateScore}%)</summary>`,
          '',
          formatFailureReport(result, qgConfig),
          '',
          '**Escalation Diagnosis:**',
          escalationNote,
          '',
          '</details>',
          '',
          resultContent,
          '',
          deliveryMeta,
        ].join('\n'))
        // Free memory: dispose after escalation — no more cycles will run
        this.context.teammate.disposeAgent(sessionId, 'qg-escalated')
        await this.maybeArchiveCompletedTeamSession(sessionId)
        return
      }

      this.context.team.logActivity(resolvedTeamId, 'quality-gate-failed', `Quality gate failed at ${this.context.quality.formatPercentScore(result.aggregateScore)} (cycle ${currentCycle}/${qgConfig.maxReviewCycles})`, managed.id, teammateName)
      await this.context.messaging.sendToSession(sessionId, [
        this.context.quality.buildWorkerFeedback(result, qgConfig.maxReviewCycles),
        '',
        formatFailureReport(result, qgConfig),
      ].join('\n'))
      this.context.team.logActivity(resolvedTeamId, 'review-feedback-sent', `Quality feedback sent (cycle ${currentCycle}/${qgConfig.maxReviewCycles})`, managed.id, teammateName)
    } catch (err) {
      this.context.quality.cycles.delete(cycleKey)
      sessionLog.error(`[AgentTeams] Quality gate pipeline error for "${teammateName}":`, err)
      await this.relayTeammateMessages(managed.parentSessionId!, `${teammateName} completed (quality gate skipped due to error)`, resultContent, deliveryMeta)
      await this.maybeArchiveCompletedTeamSession(sessionId)
    }
  }
}
