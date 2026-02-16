/**
 * TeamDashboard
 *
 * Main dashboard view for an active agent team.
 * Composed of:
 * - TeamHeader (top bar with team name, status, controls)
 * - TeammateSidebar (left: teammate list with status)
 * - TeammateDetailView or TeamActivityFeed (center: selected view)
 * - TaskListPanel (bottom: collapsible task board)
 *
 * This component reads real session data from Jotai atoms instead of
 * AgentTeamManager in-memory state. It accepts the lead session and
 * looks up teammate sessions via sessionMetaMapAtom.
 */

import * as React from 'react'
import { useState, useEffect, useMemo, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { Plus, Activity, FileCheck2, GitBranch, LayoutGrid, Focus, Send, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cn } from '@/lib/utils'
import { stripMarkdown } from '@/utils/text'
import { sessionMetaMapAtom } from '@/atoms/sessions'
import type { SessionMeta } from '@/atoms/sessions'
import type {
  Session,
  AgentTeam,
  AgentTeammate,
  AgentTeammateStatus,
  TeamTask,
  TeammateMessage,
  TeamActivityEvent,
  TeamCostSummary,
  QualityGateResult,
  WorkspaceSettings,
  ModelPresetId,
  YoloState,
  TeamPhase,
} from '../../../shared/types'

import { TeamHeader } from './TeamHeader'
import { TeammateSidebar } from './TeammateSidebar'
import { TeammateDetailView } from './TeammateDetailView'
import { TaskListPanel } from './TaskListPanel'
import { TeamActivityFeed } from './TeamActivityFeed'
import { HealthAlertsCard } from './HealthAlertsCard'
import { TeamCreationDialog } from './TeamCreationDialog'
import { QualityGateReport } from './QualityGateReport'
import { SpecCoveragePanel } from './SpecCoveragePanel'
import { SpecTraceabilityPanel } from './SpecTraceabilityPanel'
import { TeamSidebarCompact } from './TeamSidebarCompact'
import { SpecChecklistModal } from './SpecChecklistModal'
import { useTeamStateSync } from '@/hooks/useTeamEvents'
import { ToolActivityIndicator } from './ToolActivityIndicator'
import type { ToolActivity } from './ToolActivityIndicator'

const MODEL_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'kimi-k2.5': 'Kimi K2.5',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
}

const MAX_REALTIME_MESSAGES = 2000
const MAX_REALTIME_ACTIVITY = 1500
const MAX_TOOL_ACTIVITIES_PER_TEAMMATE = 5
const MAX_HEALTH_ISSUES_PER_TEAMMATE = 3

interface TeammateHealthIssue {
  issueType: 'stall' | 'error-loop' | 'retry-storm' | 'context-exhaustion'
  details: string
  timestamp: string
}
const EMPTY_TASKS: TeamTask[] = []
const EMPTY_MESSAGES: TeammateMessage[] = []
const EMPTY_ACTIVITY: TeamActivityEvent[] = []

/**
 * Derive an AgentTeammateStatus from a teammate's SessionMeta
 */
function deriveTeammateStatus(meta: SessionMeta): AgentTeammateStatus {
  if (meta.isProcessing) return 'working'
  // If has messages and not processing, treat as idle (completed their last task)
  if (meta.messageCount && meta.messageCount > 0) return 'idle'
  return 'idle'
}

/**
 * Map a SessionMeta to the AgentTeammate shape expected by sub-components
 */
function sessionMetaToTeammate(meta: SessionMeta, isLead: boolean): AgentTeammate {
  return {
    id: meta.id,
    name: meta.teammateName || meta.name || meta.id,
    role: isLead ? 'lead' : (meta.teammateRole || 'worker'),
    agentId: meta.id,
    sessionId: meta.id,
    status: deriveTeammateStatus(meta),
    model: meta.model || 'unknown',
    provider: 'anthropic',
    isLead,
    tokenUsage: meta.tokenUsage
      ? {
          inputTokens: meta.tokenUsage.inputTokens,
          outputTokens: meta.tokenUsage.outputTokens,
          costUsd: meta.tokenUsage.costUsd,
        }
      : undefined,
  }
}

export interface TeamDashboardProps {
  /** The lead session for this team */
  session: Session
  /** Live team status from team manager */
  teamStatus?: AgentTeam
  /** All tasks for the active team */
  tasks?: TeamTask[]
  /** All messages for the active team */
  messages?: TeammateMessage[]
  /** Activity log events */
  activityEvents?: TeamActivityEvent[]
  /** Cost summary */
  cost?: TeamCostSummary
  /** Quality gate results per teammate (keyed by teammate session ID) */
  qualityReports?: Map<string, QualityGateResult>
  /** Called to create a new team */
  onCreateTeam?: (config: { name: string; teammates: { name: string; role: string; model: string }[]; preset: string }) => void
  /** Called to clean up the team */
  onCleanupTeam?: () => void
  /** Called to toggle delegate mode */
  onToggleDelegateMode?: () => void
  /** Called to send a message to a teammate */
  onSendMessage: (teammateId: string, content: string) => void
  /** Called to swap a teammate's model */
  onSwapModel?: (teammateId: string) => void
  /** Called to shut down a teammate */
  onShutdownTeammate?: (teammateId: string) => void
  /** Called to escalate a teammate */
  onEscalateTeammate?: (teammateId: string) => void
  /** Whether spec mode is active for this workspace/session */
  specModeEnabled?: boolean
  /** Active spec label (title/path) */
  specLabel?: string
  /** Requirement coverage data */
  specRequirements?: Array<{
    id: string
    description: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    status: 'pending' | 'in-progress' | 'implemented' | 'verified'
    linkedTaskIds?: string[]
    linkedTestPatterns?: string[]
  }>
  /** Requirement traceability map */
  specTraceabilityMap?: Array<{
    requirementId: string
    files: string[]
    tests: string[]
    tasks: string[]
    tickets: string[]
  }>
  /** Called when a requirement is selected */
  onSpecRequirementClick?: (requirementId: string) => void
  /** Called when a requirement status changes */
  onSpecRequirementStatusChange?: (requirementId: string, status: 'pending' | 'in-progress' | 'implemented' | 'verified') => void
  /** Called to complete/finalize the team session */
  onCompleteTeam?: () => void
}

export function TeamDashboard({
  session,
  teamStatus,
  tasks = EMPTY_TASKS,
  messages = EMPTY_MESSAGES,
  activityEvents = EMPTY_ACTIVITY,
  cost,
  qualityReports,
  onCreateTeam,
  onCleanupTeam,
  onToggleDelegateMode,
  onSendMessage,
  onSwapModel,
  onShutdownTeammate,
  onEscalateTeammate,
  specModeEnabled = false,
  specLabel,
  specRequirements = [],
  specTraceabilityMap = [],
  onSpecRequirementClick,
  onSpecRequirementStatusChange,
  onCompleteTeam,
}: TeamDashboardProps) {
  const [viewMode, setViewMode] = useState<'overview' | 'focus'>('overview')
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | undefined>()
  const [taskListCollapsed, setTaskListCollapsed] = useState(true)
  const [activeTab, setActiveTab] = useState<'teammate' | 'activity' | 'spec-coverage' | 'traceability'>('teammate')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [checklistOpen, setChecklistOpen] = useState(false)
  const [compactSidebarMode, setCompactSidebarMode] = useState(false)
  const [compactSidebarExpanded, setCompactSidebarExpanded] = useState(false)
  const [highlightedTaskIds, setHighlightedTaskIds] = useState<string[]>([])
  const [quickReplyByTeammate, setQuickReplyByTeammate] = useState<Record<string, string>>({})
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceSettings | null>(null)

  // Real-time event state for Command Center cards
  const [realtimeTeammateStatus, setRealtimeTeammateStatus] = useState<Record<string, AgentTeammateStatus>>({})
  const [realtimeMessages, setRealtimeMessages] = useState<TeammateMessage[]>(messages)
  const [realtimeTasks, setRealtimeTasks] = useState<TeamTask[]>(tasks)
  const [realtimeActivity, setRealtimeActivity] = useState<TeamActivityEvent[]>(activityEvents)
  const [realtimeToolActivity, setRealtimeToolActivity] = useState<Record<string, ToolActivity[]>>({})
  const [realtimeHealthIssues, setRealtimeHealthIssues] = useState<Record<string, TeammateHealthIssue[]>>({})
  const [yoloState, setYoloState] = useState<YoloState | null>(null)
  const [yoloPhases, setYoloPhases] = useState<TeamPhase[]>([])

  // Read teammate session metadata from Jotai atoms
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  // Subscribe to real-time team events
  const teamEventsHook = useTeamStateSync(
    session.teamId || session.id,
    {
      onTeammateUpdated: (event) => {
        const teammate = event.payload.teammate
        setRealtimeTeammateStatus((prev) => ({
          ...prev,
          [teammate.id]: teammate.status,
        }))
      },
      onMessageSent: (event) => {
        const message = event.payload.message
        setRealtimeMessages((prev) => [...prev, message].slice(-MAX_REALTIME_MESSAGES))
      },
      onTaskUpdated: (event) => {
        const updatedTask = event.payload.task
        setRealtimeTasks((prev) => {
          const index = prev.findIndex(t => t.id === updatedTask.id)
          if (index >= 0) {
            const newTasks = [...prev]
            newTasks[index] = updatedTask
            return newTasks
          }
          return prev
        })
      },
      onTaskCreated: (event) => {
        const newTask = event.payload.task
        setRealtimeTasks((prev) => [...prev, newTask])
      },
      onActivityLogged: (event) => {
        const activity = event.payload.activity
        setRealtimeActivity((prev) => [...prev, activity].slice(-MAX_REALTIME_ACTIVITY))
      },
      onTeammateHealthIssue: (event) => {
        const { teammateId, issueType, details } = event.payload
        setRealtimeHealthIssues((prev) => {
          const existing = prev[teammateId] ?? []
          const entry: TeammateHealthIssue = {
            issueType,
            details,
            timestamp: event.timestamp,
          }
          const updated = [entry, ...existing].slice(0, MAX_HEALTH_ISSUES_PER_TEAMMATE)
          return { ...prev, [teammateId]: updated }
        })
      },
      onTeammateToolActivity: (event) => {
        const { teammateId, toolName, toolDisplayName, toolIntent, toolUseId, status, inputPreview, resultPreview, isError, elapsedMs } = event.payload
        setRealtimeToolActivity((prev) => {
          const existing = prev[teammateId] ?? []
          // For completed/error status, update the existing entry if present
          if (status !== 'executing') {
            const idx = existing.findIndex(a => a.toolUseId === toolUseId)
            if (idx >= 0) {
              const updated = [...existing]
              updated[idx] = { ...updated[idx], status, resultPreview, isError, elapsedMs }
              return { ...prev, [teammateId]: updated }
            }
          }
          // New tool activity — add to ring buffer
          const entry: ToolActivity = {
            toolName,
            toolDisplayName,
            toolIntent,
            toolUseId,
            status,
            inputPreview,
            resultPreview,
            isError,
            elapsedMs,
            timestamp: event.timestamp,
          }
          const updated = [entry, ...existing].slice(0, MAX_TOOL_ACTIVITIES_PER_TEAMMATE)
          return { ...prev, [teammateId]: updated }
        })
      },
      onYoloStateChanged: (event) => {
        setYoloState(event.payload.state)
        if (event.payload.phases) {
          setYoloPhases(event.payload.phases)
        }
      },
    },
    {
      // Don't use mock mode in production
      mock: false,
    }
  )

  // Fetch initial YOLO state on mount
  useEffect(() => {
    const teamId = session.teamId || session.id
    if (!window.electronAPI?.getYoloState || !teamId) return
    let cancelled = false
    window.electronAPI.getYoloState(teamId)
      .then((state) => {
        if (!cancelled && state) {
          setYoloState(state)
        }
      })
      .catch(() => { /* ignore - YOLO not active */ })
    return () => { cancelled = true }
  }, [session.teamId, session.id])

  // Implements REQ-002: Load persisted team state (messages, tasks, activity) on mount
  useEffect(() => {
    if (!window.electronAPI?.getPersistedTeamState) return
    let cancelled = false
    window.electronAPI.getPersistedTeamState(session.id)
      .then((state) => {
        if (cancelled || !state) return
        // BUG-013 fix: Check cancelled before EACH state update to prevent unmounted updates
        if (state.messages?.length && !cancelled) {
          setRealtimeMessages((prev) => {
            const existingIds = new Set(prev.map(m => m.id))
            // BUG-016 fix: Sort by timestamp before capping to keep newest messages
            const merged = [...state.messages.filter(m => !existingIds.has(m.id)), ...prev]
            merged.sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''))
            return merged.slice(-MAX_REALTIME_MESSAGES)
          })
        }
        if (state.tasks?.length && !cancelled) {
          setRealtimeTasks((prev) => {
            const existingIds = new Set(prev.map(t => t.id))
            const merged = [...state.tasks.filter(t => !existingIds.has(t.id)), ...prev]
            return merged
          })
        }
        if (state.activity?.length && !cancelled) {
          setRealtimeActivity((prev) => {
            const existingIds = new Set(prev.map(a => a.id))
            const merged = [...state.activity.filter(a => !existingIds.has(a.id)), ...prev]
            return merged.slice(-MAX_REALTIME_ACTIVITY)
          })
        }
      })
      .catch(() => { /* no persisted state — first-time team */ })
    return () => { cancelled = true }
  }, [session.id])

  // Sync realtime state with props when they change
  useEffect(() => {
    setRealtimeMessages(messages)
  }, [messages])

  useEffect(() => {
    setRealtimeTasks(tasks)
  }, [tasks])

  useEffect(() => {
    setRealtimeActivity(activityEvents)
  }, [activityEvents])

  useEffect(() => {
    let cancelled = false
    if (!window.electronAPI || !session.workspaceId) return
    window.electronAPI.getWorkspaceSettings(session.workspaceId)
      .then((settings) => {
        if (!cancelled) setWorkspaceSettings(settings ?? null)
      })
      .catch(() => {
        if (!cancelled) setWorkspaceSettings(null)
      })
    return () => {
      cancelled = true
    }
  }, [session.workspaceId])

  // Implements BUG-2: derive spec coverage percentage from requirements data
  const specCoveragePercent = useMemo(() => {
    if (!specModeEnabled || specRequirements.length === 0) return undefined
    const verified = specRequirements.filter(r => r.status === 'verified').length
    const implemented = specRequirements.filter(r => r.status === 'implemented').length
    const inProgress = specRequirements.filter(r => r.status === 'in-progress').length
    return Math.round(((verified + implemented * 0.75 + inProgress * 0.25) / specRequirements.length) * 100)
  }, [specModeEnabled, specRequirements])

  // Implements BUG-6: check if YOLO is enabled in workspace settings
  const yoloEnabled = workspaceSettings?.yoloMode !== undefined && workspaceSettings.yoloMode !== 'off'

  // Implements REQ-004: gate team creation when SDD is enabled without an active spec
  const sddBlocked = specModeEnabled && !session.activeSpecId
  // Implements REQ-001: default preset to workspace settings
  const presetFromSettings = (workspaceSettings?.agentTeamsModelPreset as ModelPresetId | undefined) ?? 'cost-optimized'
  const lockPresetSelection = !!workspaceSettings?.agentTeamsModelPreset

  // Build the teammates list from real session metadata
  const teammates: AgentTeammate[] = useMemo(() => {
    const teammateIds = session.teammateSessionIds || []
    const result: AgentTeammate[] = []
    const seenIds = new Set<string>()

    // Add the lead session itself as the first teammate
    const leadMeta = sessionMetaMap.get(session.id)
    if (leadMeta) {
      result.push(sessionMetaToTeammate(leadMeta, true))
      seenIds.add(session.id)
    }

    // Add each teammate session
    for (const id of teammateIds) {
      if (seenIds.has(id)) continue
      const meta = sessionMetaMap.get(id)
      if (meta) {
        result.push(sessionMetaToTeammate(meta, false))
        seenIds.add(id)
      }
    }

    return result
  }, [session.id, session.teammateSessionIds, sessionMetaMap])

  const teammatesWithTasks = useMemo(() => {
    const taskByAssignee = new Map<string, TeamTask[]>()
    realtimeTasks.forEach((task) => {
      if (!task.assignee) return
      const existing = taskByAssignee.get(task.assignee) ?? []
      existing.push(task)
      taskByAssignee.set(task.assignee, existing)
    })

    return teammates.map((teammate) => {
      const assigned = taskByAssignee.get(teammate.id) ?? []
      const activeTask = assigned.find(t => t.status === 'in_progress') ?? assigned[0]
      // Use realtime status if available, otherwise fall back to derived status
      const status = realtimeTeammateStatus[teammate.id] ?? teammate.status
      return {
        ...teammate,
        status,
        currentTask: activeTask?.title ?? teammate.currentTask,
      }
    })
  }, [teammates, realtimeTasks, realtimeTeammateStatus])

  // Derive the AgentTeam object for sub-components (TeamHeader, etc.)
  const team: AgentTeam = useMemo(() => ({
    id: teamStatus?.id ?? session.teamId ?? session.id,
    name: teamStatus?.name ?? (session.name || 'Agent Team'),
    leadSessionId: teamStatus?.leadSessionId ?? session.id,
    status: teamStatus?.status ?? (session.isProcessing ? 'active' : 'active'),
    createdAt: teamStatus?.createdAt ?? (session.createdAt ? new Date(session.createdAt).toISOString() : new Date().toISOString()),
    members: teammatesWithTasks,
    delegateMode: teamStatus?.delegateMode ?? false,
  }), [teamStatus, session.id, session.teamId, session.name, session.isProcessing, session.createdAt, teammatesWithTasks])

  // Auto-select the lead teammate on initial mount or when switching to a different team
  const prevSessionIdRef = useRef<string | null>(null)
  useEffect(() => {
    const isNewTeam = prevSessionIdRef.current !== session.id
    prevSessionIdRef.current = session.id
    if (!isNewTeam) return

    if (teammates.length > 0) {
      const lead = teammates.find(m => m.isLead)
      setSelectedTeammateId(lead?.id || teammates[0].id)
      setViewMode('overview')
    } else {
      setSelectedTeammateId(undefined)
    }
  }, [session.id, teammates])

  const handleQuickReplySend = React.useCallback((teammateId: string) => {
    const draft = quickReplyByTeammate[teammateId]?.trim()
    if (!draft) return
    onSendMessage(teammateId, draft)
    setQuickReplyByTeammate((prev) => ({ ...prev, [teammateId]: '' }))
  }, [quickReplyByTeammate, onSendMessage])

  const handleStopAllWorkers = React.useCallback(() => {
    if (!onShutdownTeammate) return
    const workers = teammates.filter(m => !m.isLead)
    workers.forEach(worker => onShutdownTeammate(worker.id))
  }, [teammates, onShutdownTeammate])

  const handleYoloStart = React.useCallback((objective: string) => {
    const teamId = session.teamId || session.id
    if (!window.electronAPI?.startYolo || !teamId) return
    window.electronAPI.startYolo(teamId, objective)
      .then(setYoloState)
      .catch((err: unknown) => console.error('[TeamDashboard] YOLO start failed:', err))
  }, [session.teamId, session.id])

  const handleYoloPause = React.useCallback(() => {
    const teamId = session.teamId || session.id
    if (!window.electronAPI?.pauseYolo || !teamId) return
    window.electronAPI.pauseYolo(teamId)
      .catch((err: unknown) => console.error('[TeamDashboard] YOLO pause failed:', err))
  }, [session.teamId, session.id])

  const handleYoloAbort = React.useCallback(() => {
    const teamId = session.teamId || session.id
    if (!window.electronAPI?.abortYolo || !teamId) return
    window.electronAPI.abortYolo(teamId)
      .catch((err: unknown) => console.error('[TeamDashboard] YOLO abort failed:', err))
  }, [session.teamId, session.id])

  const selectedTeammate = teammatesWithTasks.find(m => m.id === selectedTeammateId)
  const teammateActiveTaskCount = useMemo(() => {
    const counts = new Map<string, number>()
    realtimeTasks.forEach((task) => {
      if (!task.assignee || task.status !== 'in_progress') return
      counts.set(task.assignee, (counts.get(task.assignee) || 0) + 1)
    })
    return counts
  }, [realtimeTasks])

  const compactRecentActivity = useMemo(() => realtimeActivity.slice(-5).reverse(), [realtimeActivity])
  const recentMessagesByTeammate = useMemo(() => {
    const byTeammate = new Map<string, TeammateMessage[]>()
    const teammateIds = new Set(teammatesWithTasks.map((teammate) => teammate.id))
    teammatesWithTasks.forEach((teammate) => byTeammate.set(teammate.id, []))

    realtimeMessages.forEach((msg) => {
      if (msg.to === 'all') {
        byTeammate.forEach((arr) => arr.push(msg))
        return
      }

      if (teammateIds.has(msg.from)) {
        byTeammate.get(msg.from)?.push(msg)
      }
      if (teammateIds.has(msg.to) && msg.to !== msg.from) {
        byTeammate.get(msg.to)?.push(msg)
      }
    })

    byTeammate.forEach((arr, teammateId) => {
      byTeammate.set(teammateId, arr.slice(-3))
    })

    return byTeammate
  }, [realtimeMessages, teammatesWithTasks])

  // No team ID on session — show empty state with create button
  if (!session.teamId && !session.isTeamLead) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full">
        <div className="text-center space-y-6">
          <div className="size-16 rounded-full bg-foreground/5 flex items-center justify-center mx-auto">
            <Plus className="size-6 text-muted-foreground" />
          </div>
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">No Active Team</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Create a team to start multi-agent collaboration
            </p>
          </div>
          {onCreateTeam && (
            <Button
              onClick={() => setCreateDialogOpen(true)}
              size="sm"
              disabled={sddBlocked}
              title={sddBlocked ? 'SDD is enabled: choose an active spec before creating a team' : undefined}
            >
              Create Team
            </Button>
          )}
          {sddBlocked && (
            <p className="text-xs text-muted-foreground">
              Spec-Driven Development is enabled. Select an active spec before creating a team.
            </p>
          )}
        </div>

        {onCreateTeam && (
          <TeamCreationDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
            defaultPreset={presetFromSettings}
            lockPresetSelection={lockPresetSelection}
            onCreateTeam={(config) => {
              onCreateTeam(config)
              setCreateDialogOpen(false)
            }}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* Team Header */}
      <TeamHeader
        team={team}
        cost={cost}
        onToggleDelegateMode={onToggleDelegateMode}
        onCleanupTeam={onCleanupTeam}
        onStopAllWorkers={onShutdownTeammate ? handleStopAllWorkers : undefined}
        specModeEnabled={specModeEnabled}
        specLabel={specLabel}
        specCoveragePercent={specCoveragePercent}
        isCompactSidebarMode={compactSidebarMode}
        onToggleCompactSidebarMode={() => {
          setCompactSidebarMode(prev => !prev)
          setCompactSidebarExpanded(false)
        }}
        yoloState={yoloState}
        onYoloStart={yoloEnabled ? handleYoloStart : undefined}
        onYoloPause={yoloEnabled ? handleYoloPause : undefined}
        onYoloAbort={yoloEnabled ? handleYoloAbort : undefined}
      />

      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <p className="text-sm text-muted-foreground">
          {viewMode === 'overview'
            ? 'Command Center: monitor all teammates and send quick replies'
            : `Focus View: ${selectedTeammate?.name ?? 'Teammate'}`}
        </p>
        <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'overview' | 'focus')}>
          <TabsList className="h-8">
            <TabsTrigger value="overview" className="text-xs gap-1.5 h-7 px-3">
              <LayoutGrid className="size-3" />
              Command Center
            </TabsTrigger>
            <TabsTrigger value="focus" className="text-xs gap-1.5 h-7 px-3" disabled={!selectedTeammateId}>
              <Focus className="size-3" />
              Focus View
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Main content area */}
      {viewMode === 'overview' ? (
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          <HealthAlertsCard
            events={realtimeActivity}
            className="mb-3"
            onOpenActivity={() => {
              setActiveTab('activity')
              setViewMode('focus')
            }}
          />
          <div className="grid grid-cols-1 xl:grid-cols-2 2xl:grid-cols-3 gap-3">
            {teammatesWithTasks.map((teammate) => {
              const activeCount = teammateActiveTaskCount.get(teammate.id) || 0
              const recent = recentMessagesByTeammate.get(teammate.id) ?? []
              const draft = quickReplyByTeammate[teammate.id] ?? ''
              const toolActivities = realtimeToolActivity[teammate.id] ?? []
              const healthIssues = realtimeHealthIssues[teammate.id] ?? []
              return (
                <div
                  key={teammate.id}
                  className={cn(
                    'rounded-lg p-3 shadow-tinted transition-shadow hover:shadow-middle',
                    healthIssues.length > 0 ? 'bg-destructive/[0.03]' : teammate.status === 'working' ? 'bg-accent/[0.03]' : 'bg-background',
                  )}
                  style={{ '--shadow-color': healthIssues.length > 0 ? 'var(--destructive-rgb)' : 'var(--accent-rgb)' } as React.CSSProperties}
                >
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => {
                      setSelectedTeammateId(teammate.id)
                      setActiveTab('teammate')
                      setViewMode('focus')
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      {/* Implements REQ-002: Show teammate name and role */}
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold truncate">{teammate.name}</h3>
                        <p className="text-[11px] text-muted-foreground truncate capitalize">
                          {teammate.role} • {MODEL_NAMES[teammate.model] || teammate.model}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {healthIssues.length > 0 && (
                          <Badge
                            variant="destructive"
                            className="text-[10px] px-1.5 py-0.5 gap-1"
                            title={healthIssues[0].details}
                          >
                            <AlertTriangle className="size-2.5" />
                            {healthIssues[0].issueType}
                          </Badge>
                        )}
                        <Badge
                          variant={teammate.status === 'error' ? 'destructive' : 'secondary'}
                          className={cn(
                            'text-[10px] px-2 py-0.5',
                            teammate.status === 'working' && 'bg-success/10 text-success-text border-transparent',
                            teammate.status === 'planning' && 'bg-info/10 text-info-text border-transparent',
                          )}
                        >
                          {teammate.status}
                        </Badge>
                      </div>
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">{activeCount} active tasks</p>
                  </button>

                  {/* Live tool activity feed */}
                  {toolActivities.length > 0 && (
                    <div className="mt-3 rounded-md bg-foreground/[0.02] p-2 shadow-thin">
                      <p className="text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider mb-1 px-1">Live Activity</p>
                      <ToolActivityIndicator activities={toolActivities} />
                    </div>
                  )}

                  {/* Recent messages */}
                  <div className={cn(
                    'rounded-md bg-foreground/[0.02] p-2 min-h-12 space-y-1.5 shadow-thin',
                    toolActivities.length > 0 ? 'mt-2' : 'mt-3',
                  )}>
                    {recent.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        {toolActivities.length > 0 ? 'No recent messages' : 'No recent activity'}
                      </p>
                    ) : (
                      recent.map((msg) => {
                        const isFromTeammate = msg.from === teammate.id
                        return (
                          <div
                            key={msg.id}
                            className={cn(
                              'text-xs leading-snug rounded-md px-2 py-1',
                              isFromTeammate
                                ? 'bg-background shadow-minimal'
                                : 'bg-foreground/[0.04]'
                            )}
                          >
                            <span className="font-medium text-foreground/85 mr-1">
                              {isFromTeammate ? teammate.name : msg.from === 'user' ? 'You' : msg.from}:
                            </span>
                            <span className="text-muted-foreground">{stripMarkdown(msg.content).slice(0, 90)}</span>
                          </div>
                        )
                      })
                    )}
                  </div>

                  <div className="mt-3 flex items-center gap-2">
                    <Input
                      value={draft}
                      onChange={(e) => setQuickReplyByTeammate(prev => ({ ...prev, [teammate.id]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          handleQuickReplySend(teammate.id)
                        }
                      }}
                      className="h-8 flex-1 text-xs"
                      placeholder={`Quick reply to ${teammate.name}...`}
                      aria-label={`Quick reply to ${teammate.name}`}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 size-8"
                      onClick={() => handleQuickReplySend(teammate.id)}
                      disabled={!draft.trim()}
                    >
                      <Send className="size-3" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        {compactSidebarMode ? (
          <TeamSidebarCompact
            teammates={teammatesWithTasks.map(t => ({
              id: t.id,
              name: t.name,
              status: t.status,
              currentTask: `${teammateActiveTaskCount.get(t.id) || 0} active`,
              model: t.model,
            }))}
            activeTasks={tasks.filter(task => task.status === 'in_progress').length}
            specCoverage={specCoveragePercent ?? 0}
            recentActivity={compactRecentActivity}
            isExpanded={compactSidebarExpanded}
            onToggleExpand={() => setCompactSidebarExpanded(prev => !prev)}
          />
        ) : (
          <TeammateSidebar
            teammates={teammatesWithTasks}
            selectedTeammateId={selectedTeammateId}
            onSelectTeammate={setSelectedTeammateId}
          />
        )}

        {/* Center panel with tabs */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <div className="flex items-center gap-1.5 px-4 py-2 border-b border-border">
            <button
              type="button"
              onClick={() => setActiveTab('teammate')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                activeTab === 'teammate'
                  ? 'bg-foreground/5 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
              )}
            >
              Teammate
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('activity')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                activeTab === 'activity'
                  ? 'bg-foreground/5 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
              )}
            >
              <Activity className="size-3" />
              Activity
              {realtimeActivity.length > 0 && (
                <span className="text-[10px] bg-foreground/10 rounded-full px-1.5">
                  {realtimeActivity.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('spec-coverage')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                activeTab === 'spec-coverage'
                  ? 'bg-foreground/5 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
              )}
            >
              <FileCheck2 className="size-3" />
              Spec Coverage
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('traceability')}
              className={cn(
                'px-3 py-1.5 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
                activeTab === 'traceability'
                  ? 'bg-foreground/5 text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
              )}
            >
              <GitBranch className="size-3" />
              Traceability
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {activeTab === 'teammate' && selectedTeammate ? (
              <div className="flex flex-col h-full">
                {/* Quality gate report (if available for this teammate) */}
                {qualityReports?.has(selectedTeammate.sessionId) && (
                  <div className="px-3 py-2 border-b border-border">
                    <QualityGateReport
                      result={qualityReports.get(selectedTeammate.sessionId)!}
                      defaultExpanded={false}
                    />
                  </div>
                )}
                <div className="flex-1 min-h-0">
                  <TeammateDetailView
                    teammate={selectedTeammate}
                    messages={realtimeMessages}
                    toolActivities={realtimeToolActivity[selectedTeammate.id] ?? []}
                    onSendMessage={onSendMessage}
                    onSwapModel={onSwapModel}
                    onShutdown={onShutdownTeammate}
                    onEscalate={onEscalateTeammate}
                  />
                </div>
              </div>
            ) : activeTab === 'activity' ? (
              <TeamActivityFeed events={realtimeActivity} />
            ) : activeTab === 'spec-coverage' ? (
              <SpecCoveragePanel
                requirements={specRequirements}
                className="h-full"
                onRequirementStatusChange={onSpecRequirementStatusChange}
                onRequirementClick={(requirementId) => {
                  const matchingRequirement = specRequirements.find((req) => req.id === requirementId)
                  setHighlightedTaskIds(matchingRequirement?.linkedTaskIds || [])
                  setTaskListCollapsed(false)
                  onSpecRequirementClick?.(requirementId)
                }}
              />
            ) : activeTab === 'traceability' ? (
              <SpecTraceabilityPanel
                traceabilityMap={specTraceabilityMap}
                className="h-full"
              />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <p className="text-sm">Select a teammate</p>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Task List Panel (collapsible bottom) */}
      <TaskListPanel
        tasks={realtimeTasks}
        teammates={teammatesWithTasks}
        isCollapsed={taskListCollapsed}
        onToggleCollapsed={() => setTaskListCollapsed(prev => !prev)}
        highlightedTaskIds={highlightedTaskIds}
        phases={yoloPhases.length > 0 ? yoloPhases : undefined}
      />

      {/* Spec Checklist Modal (shown before completing with SDD mode) */}
      {specModeEnabled && (
        <SpecChecklistModal
          open={checklistOpen}
          onOpenChange={setChecklistOpen}
          requirements={specRequirements}
          coveragePercent={specCoveragePercent ?? 0}
          onConfirmComplete={() => {
            setChecklistOpen(false)
            onCompleteTeam?.()
          }}
          onGoBack={() => setChecklistOpen(false)}
        />
      )}
    </div>
  )
}

