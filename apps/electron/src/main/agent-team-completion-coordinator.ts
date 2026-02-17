import { sessionLog } from './logger'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { mergeQualityGateConfig, inferTaskType, shouldSkipQualityGates } from '@craft-agent/shared/agent-teams/quality-gates'
import { type QualityGateConfig, type QualityGateResult } from '@craft-agent/core/types'
import { DiffCollector } from '@craft-agent/shared/agent-teams/diff-collector'
import { formatFailureReport, formatSuccessReport, type QualityGateRunner, type TaskContext } from './quality-gate-runner'

type StopReason = 'complete' | 'interrupted' | 'error' | 'timeout'

type ManagedSessionLike = {
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
  isTeamLead?: boolean
  isProcessing?: boolean
  teamLevelQgRunning?: boolean
  qgCycleCount?: number
  /** Guard: teammate results already relayed to lead — prevents duplicate deliveries */
  completionRelayed?: boolean
  /** Guard: synthesis prompt already sent to this lead — prevents duplicate prompts */
  synthesisPromptSent?: boolean
}

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

export class AgentTeamCompletionCoordinator {
  // Sequential QG execution: one QG pipeline at a time per team to prevent CPU/RAM spikes
  private teamQgQueue = new Map<string, Promise<void>>()

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

    const teammateName = managed.teammateName
    const resolvedTeamId = this.context.team.resolveTeamId(managed.teamId ?? managed.parentSessionId)
    const deliveryMeta = this.context.messaging.buildTeamDeliveryMetadata({ outputPresent, receiverId: managed.parentSessionId })
    const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
    const qgConfig = mergeQualityGateConfig(wsConfig?.agentTeams?.qualityGates as Partial<QualityGateConfig> | undefined)

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

    // Sequential QG: queue per team so only one QG pipeline runs at a time
    await this.enqueueQualityGate(resolvedTeamId, () => this.runIndividualQualityGates({
      managed,
      lead,
      teammateName,
      resolvedTeamId,
      resultContent,
      deliveryMeta,
      qgConfig,
      sessionId,
    }))
  }

  private async enqueueQualityGate(teamId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.teamQgQueue.get(teamId) ?? Promise.resolve()
    const current = prev.then(fn, fn)  // Run even if previous rejected
    this.teamQgQueue.set(teamId, current)
    return current
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
        this.context.messaging.clearLeadTeamState(lead)
        await this.context.messaging.sendToSession(managed.parentSessionId!, '[System] All teammates have completed their work. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
        return
      }

      const spec = managed.teamId ? this.context.team.getTeamSpec(this.context.team.resolveTeamId(managed.teamId)) : undefined
      const taskContext: TaskContext = { taskDescription: lead.name || 'Team integration check', workingDirectory: managed.workingDirectory }
      const result = await runner.runProgressive(teamReviewInput.reviewInput, taskContext, qgConfig, spec)
      this.context.team.storeQualityResult(resolvedTeamId, managed.parentSessionId!, result)

      if (result.passed) {
        this.context.messaging.clearLeadTeamState(lead)
        await this.context.messaging.sendToSession(managed.parentSessionId!, [`<details><summary>Quality Gate — PASSED (${result.aggregateScore}%)</summary>`, '', formatSuccessReport(result), '', '</details>', '', '[System] All teammates have completed their work and the team-level quality gate has passed. Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.'].join('\n'))
      } else {
        await this.context.messaging.sendToSession(managed.parentSessionId!, [`<details open><summary>Quality Gate — FAILED (${result.aggregateScore}%)</summary>`, '', formatFailureReport(result, qgConfig), '', '</details>', '', '[System] All teammates have completed, but the team-level quality gate did not pass. Review the issues above and decide how to address them — you may need to spawn additional Heads or fix issues directly.'].join('\n'))
      }
    } catch (err) {
      this.context.messaging.clearLeadTeamState(lead)
      await this.context.messaging.sendToSession(managed.parentSessionId!, '[System] All teammates have completed their work (team quality gate skipped due to error). Please review the results above, verify they are correct and complete, then synthesize a final comprehensive response for the user.')
      sessionLog.error('[AgentTeams] Team-level quality gate error:', err)
    } finally {
      lead.teamLevelQgRunning = false
    }
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
      const reviewDiff = managed.workingDirectory ? await DiffCollector.collectWorkingDiff(managed.workingDirectory) : null
      const reviewInput = this.context.quality.resolveReviewInput(reviewDiff)

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
