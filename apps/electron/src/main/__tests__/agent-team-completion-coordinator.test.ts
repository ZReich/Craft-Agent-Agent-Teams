import { beforeEach, describe, expect, it, vi } from 'vitest'

let mockedQualityGateConfig: Record<string, unknown> = { enabled: false }

vi.mock('../logger', () => ({
  default: {
    scope: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
  sessionLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('@craft-agent/shared/workspaces', () => ({
  loadWorkspaceConfig: () => ({
    agentTeams: {
      qualityGates: mockedQualityGateConfig,
    },
  }),
}))

import { AgentTeamCompletionCoordinator, inferReviewerQaVerdict, type AgentTeamCompletionContext } from '../agent-team-completion-coordinator'
import { DiffCollector } from '@craft-agent/shared/agent-teams/diff-collector'
import type { QualityGateResult } from '@craft-agent/core/types'

type ManagedSessionLike = Parameters<AgentTeamCompletionCoordinator['handleAgentTeamCompletionOnStop']>[0]

function createContext(sessions: Map<string, ManagedSessionLike>, sent: string[]): AgentTeamCompletionContext {
  return {
    sessions: {
      getById: (sessionId: string) => sessions.get(sessionId),
    },
    teammate: {
      updateTaskStatus: vi.fn(),
      autoArchiveCompletedSession: vi.fn(async () => undefined),
      getQualityGateSkipReason: vi.fn(() => null),
      disposeAgent: vi.fn(),
    },
    messaging: {
      sendToSession: vi.fn(async (_sessionId: string, message: string) => {
        sent.push(message)
      }),
      clearLeadTeamState: vi.fn(),
      buildTeamDeliveryMetadata: vi.fn(() => '<details>ok</details>'),
    },
    quality: {
      getRunner: vi.fn(() => ({
        runProgressive: vi.fn(),
        escalate: vi.fn(),
      })),
      cycles: new Map(),
      resolveReviewInput: vi.fn(() => ({ usesGitDiff: false, reviewInput: '', failureReason: 'not-needed' })),
      buildLeadSummary: vi.fn(() => ''),
      buildWorkerFeedback: vi.fn(() => ''),
      formatPercentScore: vi.fn(() => '0%'),
    },
    team: {
      resolveTeamId: (teamId: string) => teamId,
      getTeamSpec: vi.fn(),
      storeQualityResult: vi.fn(),
      logActivity: vi.fn(),
      stopHealthMonitoring: vi.fn(),
    },
  }
}

function buildPassingQualityResult(score = 92): QualityGateResult {
  return {
    passed: true,
    aggregateScore: score,
    cycleCount: 1,
    maxCycles: 3,
    reviewModel: 'claude-sonnet-4-5',
    reviewProvider: 'anthropic',
    timestamp: new Date().toISOString(),
    stages: {
      syntax: { score: 100, passed: true, issues: [], suggestions: [] },
      tests: { score: 100, passed: true, issues: [], suggestions: [], totalTests: 2, passedTests: 2, failedTests: 0, skippedTests: 0 },
      architecture: { score, passed: true, issues: [], suggestions: [] },
      simplicity: { score, passed: true, issues: [], suggestions: [] },
      errors: { score, passed: true, issues: [], suggestions: [] },
      completeness: { score, passed: true, issues: [], suggestions: [] },
    },
  }
}

describe('inferReviewerQaVerdict', () => {
  it('classifies FAIL before PASS when both words appear', () => {
    expect(inferReviewerQaVerdict('Result: FAIL due to blockers. PASS is not granted.')).toBe('fail')
  })

  it('classifies explicit pass', () => {
    expect(inferReviewerQaVerdict('QA Verdict: PASS')).toBe('pass')
  })

  it('returns unknown when no explicit verdict exists', () => {
    expect(inferReviewerQaVerdict('Reviewed notes and evidence attached.')).toBe('unknown')
  })
})

describe('AgentTeamCompletionCoordinator QA synthesis gate', () => {
  let lead: ManagedSessionLike
  let reviewer: ManagedSessionLike
  let sessions: Map<string, ManagedSessionLike>
  let sent: string[]

  beforeEach(() => {
    sent = []
    lead = {
      id: 'lead',
      isTeamLead: true,
      teamId: 'team-1',
      teammateSessionIds: ['reviewer-1'],
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [],
      isProcessing: false,
    }
    reviewer = {
      id: 'reviewer-1',
      parentSessionId: 'lead',
      teamId: 'team-1',
      teammateName: 'qa-reviewer',
      teammateRole: 'reviewer',
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [],
      isProcessing: false,
      lastMessageAt: Date.now(),
    }
    sessions = new Map([
      ['lead', lead],
      ['reviewer-1', reviewer],
    ])
  })

  it('blocks synthesis when latest reviewer verdict is FAIL', async () => {
    reviewer.messages.push({ role: 'assistant', content: 'qa-reviewer done: FAIL (blocking issues remain).' })

    const coordinator = new AgentTeamCompletionCoordinator(createContext(sessions, sent))
    await coordinator.handleAgentTeamCompletionOnStop(reviewer, reviewer.id, 'complete')

    expect(sent.some(m => m.includes('QA gate is blocking final synthesis.'))).toBe(true)
    expect(sent.some(m => m.includes('All teammates have completed their work'))).toBe(false)
  })

  it('allows synthesis when latest reviewer verdict is PASS', async () => {
    reviewer.messages.push({ role: 'assistant', content: 'qa-reviewer done: PASS' })

    const coordinator = new AgentTeamCompletionCoordinator(createContext(sessions, sent))
    await coordinator.handleAgentTeamCompletionOnStop(reviewer, reviewer.id, 'complete')

    expect(sent.some(m => m.includes('All teammates have completed their work'))).toBe(true)
    expect(sent.some(m => m.includes('QA gate is blocking final synthesis.'))).toBe(false)
  })
})

describe('AgentTeamCompletionCoordinator REQ-NEXT-005/008', () => {
  beforeEach(() => {
    mockedQualityGateConfig = {
      enabled: true,
      maxParallelReviews: 2,
      passThreshold: 90,
      maxReviewCycles: 3,
      enforceTDD: false,
      reviewModel: 'claude-sonnet-4-5',
      reviewProvider: 'anthropic',
      escalationModel: 'claude-sonnet-4-5',
      escalationProvider: 'anthropic',
      stages: {
        syntax: { enabled: false, weight: 0, binary: true },
        tests: { enabled: false, weight: 0, binary: true },
        architecture: { enabled: true, weight: 25 },
        simplicity: { enabled: true, weight: 10 },
        errors: { enabled: true, weight: 25 },
        completeness: { enabled: true, weight: 25 },
        spec_compliance: { enabled: false, weight: 20 },
        traceability: { enabled: false, weight: 15 },
        rollout_safety: { enabled: false, weight: 10 },
        design_compliance: { enabled: false, weight: 15 },
      },
    }
  })

  it('runs up to maxParallelReviews quality gates concurrently', async () => {
    const sent: string[] = []
    const lead: ManagedSessionLike = {
      id: 'lead',
      isTeamLead: true,
      teamId: 'team-1',
      teammateSessionIds: ['worker-a', 'worker-b'],
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [],
      isProcessing: false,
    }
    const workerA: ManagedSessionLike = {
      id: 'worker-a',
      name: 'Task A',
      parentSessionId: 'lead',
      teamId: 'team-1',
      teammateName: 'worker-a',
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [{ role: 'assistant', content: 'done A' }],
      isProcessing: false,
      workingDirectory: 'C:/tmp/ws',
    }
    const workerB: ManagedSessionLike = {
      id: 'worker-b',
      name: 'Task B',
      parentSessionId: 'lead',
      teamId: 'team-1',
      teammateName: 'worker-b',
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [{ role: 'assistant', content: 'done B' }],
      isProcessing: false,
      workingDirectory: 'C:/tmp/ws',
    }
    const sessions = new Map<string, ManagedSessionLike>([
      ['lead', lead],
      ['worker-a', workerA],
      ['worker-b', workerB],
    ])

    const context = createContext(sessions, sent)
    context.quality.resolveReviewInput = vi.fn(() => ({ usesGitDiff: true, reviewInput: 'diff --git a b', failureReason: undefined }))

    let active = 0
    let peak = 0
    const runProgressive = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 200))
      active -= 1
      return buildPassingQualityResult()
    })
    context.quality.getRunner = vi.fn(() => ({
      runProgressive,
      escalate: vi.fn(),
    } as any))

    const coordinator = new AgentTeamCompletionCoordinator(context)
    await Promise.all([
      coordinator.handleAgentTeamCompletionOnStop(workerA, workerA.id, 'complete'),
      coordinator.handleAgentTeamCompletionOnStop(workerB, workerB.id, 'complete'),
    ])

    expect(peak).toBeGreaterThan(1)
    expect(runProgressive).toHaveBeenCalledTimes(2)
  })

  it('reuses speculative artifacts and avoids fresh diff collection when valid', async () => {
    const sent: string[] = []
    const lead: ManagedSessionLike = {
      id: 'lead',
      isTeamLead: true,
      teamId: 'team-1',
      teammateSessionIds: ['worker-a'],
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [],
      isProcessing: false,
    }
    const speculativeDiff = { unifiedDiff: 'diff --git a/src/app.ts b/src/app.ts\n+export const x = 1;', filesAdded: [], filesChanged: ['src/app.ts'], filesDeleted: [], perFileDiffs: [], stats: { additions: 1, deletions: 0, filesChanged: 1 } } as Awaited<ReturnType<typeof DiffCollector.collectWorkingDiff>>
    const workerA: ManagedSessionLike = {
      id: 'worker-a',
      name: 'Task A',
      parentSessionId: 'lead',
      teamId: 'team-1',
      teammateName: 'worker-a',
      workspace: { rootPath: 'C:/tmp/ws' },
      messages: [{ role: 'assistant', content: 'done A' }],
      isProcessing: false,
      workingDirectory: 'C:/tmp/ws',
      speculativeReviewDiff: speculativeDiff,
      speculativeReviewFingerprint: `${speculativeDiff.unifiedDiff.length}:${speculativeDiff.unifiedDiff.slice(0, 120)}:${speculativeDiff.unifiedDiff.slice(-120)}`,
      speculativeReviewCapturedAt: Date.now(),
    }
    const sessions = new Map<string, ManagedSessionLike>([
      ['lead', lead],
      ['worker-a', workerA],
    ])

    const context = createContext(sessions, sent)
    context.quality.resolveReviewInput = vi.fn((_reviewDiff) => ({ usesGitDiff: true, reviewInput: speculativeDiff.unifiedDiff, failureReason: undefined }))
    context.quality.getRunner = vi.fn(() => ({
      runProgressive: vi.fn(async () => buildPassingQualityResult()),
      escalate: vi.fn(),
    } as any))

    const collectSpy = vi.spyOn(DiffCollector, 'collectWorkingDiff').mockResolvedValue(speculativeDiff as any)

    const coordinator = new AgentTeamCompletionCoordinator(context)
    await coordinator.handleAgentTeamCompletionOnStop(workerA, workerA.id, 'complete')

    expect(collectSpy).not.toHaveBeenCalled()
  })
})


