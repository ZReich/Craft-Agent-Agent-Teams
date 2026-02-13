/**
 * TeamStatusBar - Lightweight indicator shown at the top of chat when a team is active.
 *
 * For lead sessions: Shows "Team Lead -- N teammates" with expandable teammate list.
 * For teammate sessions: Shows "Part of team: {teamName}" with link back to lead.
 *
 * Uses real session metadata from sessionMetaMapAtom to display teammate
 * names and processing statuses. Teammate names are clickable to navigate
 * to their sessions.
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { Users, ChevronDown, ChevronUp, Loader2, ArrowUpLeft, LayoutDashboard, MessageSquare, Maximize2, Minimize2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { navigate, routes } from '@/lib/navigate'
import type { Session } from '../../../shared/types'

// Lazy-load usage components to prevent import failures from crashing TeamStatusBar
const UsageStatusBar = React.lazy(() =>
  import('./UsageStatusBar').then((mod) => ({ default: mod.UsageStatusBar }))
)
const UsageDetailPanel = React.lazy(() =>
  import('./UsageDetailPanel').then((mod) => ({ default: mod.UsageDetailPanel }))
)

export interface TeamStatusBarProps {
  session: Session
  /** Whether the team dashboard view is currently open */
  isDashboardOpen?: boolean
  /** Called to toggle between dashboard and chat views */
  onToggleDashboard?: () => void
  /** Whether focus mode is active (fullscreen chat) */
  isFocusModeActive?: boolean
  /** Called to toggle focus mode */
  onToggleFocusMode?: () => void
}

/**
 * Derive a display status from teammate session metadata.
 * - "working" if the session is currently processing
 * - "done" if the session has a todoState of done/cancelled or status-like indicator
 * - "idle" otherwise
 */
function getTeammateStatus(meta: SessionMeta | undefined): 'working' | 'idle' | 'done' {
  if (!meta) return 'idle'
  if (meta.isProcessing) return 'working'
  if (meta.todoState === 'done' || meta.todoState === 'cancelled') return 'done'
  return 'idle'
}

/** Status indicator dot color */
function statusDotColor(status: 'working' | 'idle' | 'done'): string {
  switch (status) {
    case 'working': return 'bg-info animate-pulse'
    case 'done': return 'bg-success'
    case 'idle': return 'bg-muted-foreground'
  }
}

/** Status label for screen readers and tooltip */
function statusLabel(status: 'working' | 'idle' | 'done'): string {
  switch (status) {
    case 'working': return 'Working'
    case 'done': return 'Done'
    case 'idle': return 'Idle'
  }
}

export function TeamStatusBar({
  session,
  isDashboardOpen,
  onToggleDashboard,
  isFocusModeActive,
  onToggleFocusMode,
}: TeamStatusBarProps) {
  const [expanded, setExpanded] = React.useState(false)
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)

  const isLead = session.isTeamLead === true
  const teammateSessionIds = session.teammateSessionIds ?? []
  const teamColor = session.teamColor ?? '#7c3aed' // Default purple
  const teamName = session.name ?? session.teamId ?? 'Agent Team'

  // For teammate sessions: look up the lead session
  const parentSessionId = session.parentSessionId
  const parentMeta = parentSessionId ? sessionMetaMap.get(parentSessionId) : undefined

  // For lead sessions: gather teammate metadata
  const teammates = React.useMemo(() => {
    if (!isLead) return []
    return teammateSessionIds.map(id => {
      const meta = sessionMetaMap.get(id)
      return {
        id,
        name: meta?.teammateName ?? meta?.name ?? id.slice(0, 8),
        status: getTeammateStatus(meta),
        isProcessing: meta?.isProcessing ?? false,
      }
    })
  }, [isLead, teammateSessionIds, sessionMetaMap])

  const workingCount = teammates.filter(t => t.status === 'working').length
  const doneCount = teammates.filter(t => t.status === 'done').length
  const showSpawnWarning = isLead && session.sddEnabled && teammates.length === 0

  // ----- Teammate session view (not the lead) -----
  if (!isLead && parentSessionId) {
    const leadName = parentMeta?.name ?? parentMeta?.teammateName ?? 'Team Lead'
    return (
      <div
        className="border-b border-border"
        style={{ backgroundColor: `${teamColor}08` }}
      >
        <div className="flex items-center gap-2 px-4 py-2 text-sm">
          <Users className="h-4 w-4 shrink-0" style={{ color: teamColor }} />
          <span className="text-muted-foreground">
            Part of team:
          </span>
          <button
            type="button"
            onClick={() => navigate(routes.view.allSessions(parentSessionId))}
            className="font-medium hover:underline cursor-pointer"
            style={{ color: teamColor }}
          >
            <ArrowUpLeft className="inline h-3 w-3 mr-0.5 -mt-0.5" />
            {leadName}
          </button>
          {session.isProcessing && (
            <Loader2 className="h-3 w-3 animate-spin" style={{ color: teamColor }} />
          )}
        </div>
      </div>
    )
  }

  // ----- Lead session view -----
  return (
    <div
      className="border-b border-border"
      style={{ backgroundColor: `${teamColor}08` }}
    >
      {/* Main bar */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-2 px-4 py-2 text-sm',
          'hover:brightness-95 transition-colors cursor-pointer'
        )}
      >
        <Users className="h-4 w-4 shrink-0" style={{ color: teamColor }} />
        <span className="font-medium" style={{ color: teamColor }}>
          Team Lead
        </span>
        <span className="text-muted-foreground mx-1">&mdash;</span>

        {session.isProcessing && (
          <Loader2 className="h-3 w-3 animate-spin" style={{ color: teamColor }} />
        )}

        <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {/* Summary counts */}
          {workingCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-info/10 text-info-text font-medium">
              {workingCount} working
            </span>
          )}
          {doneCount > 0 && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/10 text-success-text font-medium">
              {doneCount} done
            </span>
          )}

          <span
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium"
            style={{ backgroundColor: `${teamColor}15`, color: teamColor }}
          >
            {teammates.length} teammate{teammates.length !== 1 ? 's' : ''}
          </span>

          {expanded ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
        </span>
      </button>

      {/* Dashboard toggle button (lead sessions only) */}
      {isLead && (onToggleDashboard || onToggleFocusMode) && (
        <div className="flex items-center gap-2 px-4 py-1 border-t border-border/50">
          {onToggleDashboard && (
            <button
              type="button"
              onClick={onToggleDashboard}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors',
                isDashboardOpen
                  ? 'bg-foreground/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
              )}
            >
              {isDashboardOpen ? (
                <>
                  <MessageSquare className="h-3 w-3" />
                  Back to Chat
                </>
              ) : (
                <>
                  <LayoutDashboard className="h-3 w-3" />
                  Open Dashboard
                </>
              )}
            </button>
          )}
          {onToggleFocusMode && (
            <button
              type="button"
              onClick={onToggleFocusMode}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors',
                isFocusModeActive
                  ? 'bg-foreground/10 text-foreground font-medium'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5'
              )}
            >
              {isFocusModeActive ? (
                <>
                  <Minimize2 className="h-3 w-3" />
                  Exit Fullscreen
                </>
              ) : (
                <>
                  <Maximize2 className="h-3 w-3" />
                  Team Fullscreen
                </>
              )}
            </button>
          )}
        </div>
      )}

      {showSpawnWarning && (
        <div className="px-4 py-2 border-t border-border/50 text-xs text-info-text bg-info/10">
          No teammates have spawned yet. If delegation is expected, ensure the lead agent calls Task (team_name optional).
        </div>
      )}

      {/* Usage tracking bar - rendered outside button to avoid DOM nesting issues */}
      <React.Suspense fallback={null}>
        <UsageStatusBar sessionId={session.id} className="px-4 py-1 border-t border-border/50" />
      </React.Suspense>

      {/* Expanded teammate list + usage detail */}
      {expanded && (
        <div className="pb-2">
          {teammates.length > 0 && (
            <div className="px-4 py-1 flex flex-wrap gap-1.5">
              {teammates.map((teammate) => (
                <button
                  key={teammate.id}
                  type="button"
                  onClick={() => navigate(routes.view.allSessions(teammate.id))}
                  className={cn(
                    'inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs',
                    'bg-muted text-muted-foreground',
                    'hover:bg-accent hover:text-accent-foreground cursor-pointer transition-colors'
                  )}
                  title={`${teammate.name} — ${statusLabel(teammate.status)}. Click to open session.`}
                >
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', statusDotColor(teammate.status))} />
                  {teammate.name}
                  {teammate.isProcessing && (
                    <Loader2 className="h-3 w-3 animate-spin text-info" />
                  )}
                </button>
              ))}
            </div>
          )}

          {/* Detailed usage panel */}
          <React.Suspense fallback={null}>
            <UsageDetailPanel sessionId={session.id} className="border-t border-border/50" />
          </React.Suspense>
        </div>
      )}
    </div>
  )
}
