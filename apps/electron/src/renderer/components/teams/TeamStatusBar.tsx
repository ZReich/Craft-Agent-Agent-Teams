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
import { Users, ChevronDown, ChevronUp, Loader2, ArrowUpLeft } from 'lucide-react'
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
    case 'working': return 'bg-amber-500 animate-pulse'
    case 'done': return 'bg-green-500'
    case 'idle': return 'bg-gray-400'
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

export function TeamStatusBar({ session }: TeamStatusBarProps) {
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
            onClick={() => navigate(routes.view.allChats(parentSessionId))}
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
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              {workingCount} working
            </span>
          )}
          {doneCount > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-green-500/10 text-green-600 dark:text-green-400">
              {doneCount} done
            </span>
          )}

          <span
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
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
                  onClick={() => navigate(routes.view.allChats(teammate.id))}
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
                    <Loader2 className="h-3 w-3 animate-spin text-amber-500" />
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
