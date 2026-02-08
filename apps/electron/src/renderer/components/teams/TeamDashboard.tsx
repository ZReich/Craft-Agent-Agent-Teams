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
import { useState, useEffect, useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { Plus, Activity } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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
} from '../../../shared/types'

import { TeamHeader } from './TeamHeader'
import { TeammateSidebar } from './TeammateSidebar'
import { TeammateDetailView } from './TeammateDetailView'
import { TaskListPanel } from './TaskListPanel'
import { TeamActivityFeed } from './TeamActivityFeed'
import { TeamCreationDialog } from './TeamCreationDialog'
import { QualityGateReport } from './QualityGateReport'

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
    role: isLead ? 'lead' : 'worker',
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
  onSendMessage?: (teammateId: string, content: string) => void
  /** Called to swap a teammate's model */
  onSwapModel?: (teammateId: string) => void
  /** Called to shut down a teammate */
  onShutdownTeammate?: (teammateId: string) => void
  /** Called to escalate a teammate */
  onEscalateTeammate?: (teammateId: string) => void
}

export function TeamDashboard({
  session,
  tasks = [],
  messages = [],
  activityEvents = [],
  cost,
  qualityReports,
  onCreateTeam,
  onCleanupTeam,
  onToggleDelegateMode,
  onSendMessage,
  onSwapModel,
  onShutdownTeammate,
  onEscalateTeammate,
}: TeamDashboardProps) {
  const [selectedTeammateId, setSelectedTeammateId] = useState<string | undefined>()
  const [taskListCollapsed, setTaskListCollapsed] = useState(true)
  const [activeTab, setActiveTab] = useState<'teammate' | 'activity'>('teammate')
  const [createDialogOpen, setCreateDialogOpen] = useState(false)

  // Read teammate session metadata from Jotai atoms
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  // Build the teammates list from real session metadata
  const teammates: AgentTeammate[] = useMemo(() => {
    const teammateIds = session.teammateSessionIds || []
    const result: AgentTeammate[] = []

    // Add the lead session itself as the first teammate
    const leadMeta = sessionMetaMap.get(session.id)
    if (leadMeta) {
      result.push(sessionMetaToTeammate(leadMeta, true))
    }

    // Add each teammate session
    for (const id of teammateIds) {
      const meta = sessionMetaMap.get(id)
      if (meta) {
        result.push(sessionMetaToTeammate(meta, false))
      }
    }

    return result
  }, [session.id, session.teammateSessionIds, sessionMetaMap])

  // Derive the AgentTeam object for sub-components (TeamHeader, etc.)
  const team: AgentTeam = useMemo(() => ({
    id: session.teamId || session.id,
    name: session.name || 'Agent Team',
    leadSessionId: session.id,
    status: session.isProcessing ? 'active' : 'active',
    createdAt: session.createdAt ? new Date(session.createdAt).toISOString() : new Date().toISOString(),
    members: teammates,
    delegateMode: false,
  }), [session.id, session.teamId, session.name, session.isProcessing, session.createdAt, teammates])

  // Auto-select the lead teammate when team changes
  useEffect(() => {
    if (teammates.length > 0) {
      const lead = teammates.find(m => m.isLead)
      setSelectedTeammateId(lead?.id || teammates[0].id)
    } else {
      setSelectedTeammateId(undefined)
    }
  }, [session.id])

  const selectedTeammate = teammates.find(m => m.id === selectedTeammateId)

  // No team ID on session — show empty state with create button
  if (!session.teamId && !session.isTeamLead) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center h-full">
        <div className="text-center space-y-4">
          <div className="size-16 rounded-full bg-foreground/5 flex items-center justify-center mx-auto">
            <Plus className="size-6 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">No Active Team</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Create a team to start multi-agent collaboration
            </p>
          </div>
          {onCreateTeam && (
            <Button onClick={() => setCreateDialogOpen(true)} size="sm">
              Create Team
            </Button>
          )}
        </div>

        {onCreateTeam && (
          <TeamCreationDialog
            open={createDialogOpen}
            onOpenChange={setCreateDialogOpen}
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
      />

      {/* Main content area */}
      <div className="flex-1 flex min-h-0">
        {/* Teammate Sidebar */}
        <TeammateSidebar
          teammates={teammates}
          selectedTeammateId={selectedTeammateId}
          onSelectTeammate={setSelectedTeammateId}
        />

        {/* Center panel with tabs */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Tab bar */}
          <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border">
            <button
              type="button"
              onClick={() => setActiveTab('teammate')}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-colors',
                activeTab === 'teammate'
                  ? 'bg-foreground/5 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.02]'
              )}
            >
              Teammate
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('activity')}
              className={cn(
                'px-2.5 py-1 text-xs rounded-md transition-colors flex items-center gap-1',
                activeTab === 'activity'
                  ? 'bg-foreground/5 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.02]'
              )}
            >
              <Activity className="size-3" />
              Activity
              {activityEvents.length > 0 && (
                <span className="text-[10px] bg-foreground/10 rounded-full px-1.5">
                  {activityEvents.length}
                </span>
              )}
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
                    messages={messages}
                    onSendMessage={onSendMessage || (() => {})}
                    onSwapModel={onSwapModel}
                    onShutdown={onShutdownTeammate}
                    onEscalate={onEscalateTeammate}
                  />
                </div>
              </div>
            ) : activeTab === 'activity' ? (
              <TeamActivityFeed events={activityEvents} />
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                <p className="text-sm">Select a teammate</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Task List Panel (collapsible bottom) */}
      <TaskListPanel
        tasks={tasks}
        teammates={teammates}
        isCollapsed={taskListCollapsed}
        onToggleCollapsed={() => setTaskListCollapsed(prev => !prev)}
      />
    </div>
  )
}
