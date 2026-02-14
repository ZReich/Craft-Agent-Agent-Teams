/**
 * TeamActivityFeed
 *
 * Timeline showing cross-team events: messages, task updates,
 * plan submissions, errors, and escalations.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
import {
  MessageSquare,
  CheckCircle2,
  AlertCircle,
  UserPlus,
  UserMinus,
  ArrowUpCircle,
  RefreshCw,
  ClipboardList,
  ThumbsUp,
  ThumbsDown,
  DollarSign,
  AlertTriangle,
  SearchCheck,
  ArrowDown,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useScrollAnchor } from '@/hooks/useScrollAnchor'
import type { TeamActivityEvent, TeamActivityType } from '../../../shared/types'

export interface TeamActivityFeedProps {
  events: TeamActivityEvent[]
  className?: string
}

const EVENT_CONFIG: Record<TeamActivityType, {
  icon: React.ComponentType<{ className?: string }>
  color: string
}> = {
  'teammate-spawned': { icon: UserPlus, color: 'text-green-500' },
  'teammate-shutdown': { icon: UserMinus, color: 'text-muted-foreground' },
  'task-claimed': { icon: ClipboardList, color: 'text-blue-500' },
  'task-in-review': { icon: SearchCheck, color: 'text-purple-500' },
  'task-completed': { icon: CheckCircle2, color: 'text-green-500' },
  'task-failed': { icon: AlertCircle, color: 'text-destructive' },
  'quality-gate-passed': { icon: CheckCircle2, color: 'text-green-500' },
  'quality-gate-failed': { icon: AlertCircle, color: 'text-destructive' },
  'review-feedback-sent': { icon: MessageSquare, color: 'text-amber-500' },
  'message-sent': { icon: MessageSquare, color: 'text-foreground/70' },
  'plan-submitted': { icon: ClipboardList, color: 'text-purple-500' },
  'plan-approved': { icon: ThumbsUp, color: 'text-green-500' },
  'plan-rejected': { icon: ThumbsDown, color: 'text-yellow-500' },
  'model-swapped': { icon: RefreshCw, color: 'text-blue-500' },
  'escalation': { icon: ArrowUpCircle, color: 'text-yellow-500' },
  'integration-check-started': { icon: RefreshCw, color: 'text-blue-500' },
  'integration-check-passed': { icon: CheckCircle2, color: 'text-green-500' },
  'integration-check-failed': { icon: AlertCircle, color: 'text-destructive' },
  'stall-detected': { icon: AlertTriangle, color: 'text-yellow-500' },
  'file-conflict': { icon: AlertTriangle, color: 'text-orange-500' },
  'checkpoint-created': { icon: ClipboardList, color: 'text-cyan-500' },
  'checkpoint-rollback': { icon: RefreshCw, color: 'text-orange-500' },
  'cost-warning': { icon: DollarSign, color: 'text-yellow-500' },
  'yolo-started': { icon: ArrowUpCircle, color: 'text-blue-500' },
  'yolo-phase-changed': { icon: RefreshCw, color: 'text-blue-500' },
  'yolo-paused': { icon: AlertTriangle, color: 'text-yellow-500' },
  'yolo-completed': { icon: CheckCircle2, color: 'text-green-500' },
  'yolo-aborted': { icon: AlertCircle, color: 'text-destructive' },
  'yolo-remediation-created': { icon: ClipboardList, color: 'text-amber-500' },
  'yolo-spec-evolution-proposed': { icon: SearchCheck, color: 'text-purple-500' },
  'phase-advanced': { icon: ArrowUpCircle, color: 'text-cyan-500' },
  'phase-blocked': { icon: AlertTriangle, color: 'text-orange-500' },
  'error': { icon: AlertTriangle, color: 'text-destructive' },
}

type FilterType = 'all' | 'tasks' | 'messages' | 'system'

const FILTER_OPTIONS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'messages', label: 'Messages' },
  { id: 'system', label: 'System' },
]

const TASK_TYPES = new Set<TeamActivityType>([
  'task-claimed',
  'task-in-review',
  'task-completed',
  'task-failed',
  'quality-gate-passed',
  'quality-gate-failed',
  'review-feedback-sent',
  'integration-check-started',
  'integration-check-passed',
  'integration-check-failed',
  'file-conflict',
  'checkpoint-created',
  'checkpoint-rollback',
  'phase-advanced',
  'phase-blocked',
  'yolo-started',
  'yolo-phase-changed',
  'yolo-paused',
  'yolo-completed',
  'yolo-aborted',
  'yolo-remediation-created',
  'yolo-spec-evolution-proposed',
])
const MESSAGE_TYPES = new Set<TeamActivityType>(['message-sent', 'plan-submitted', 'plan-approved', 'plan-rejected'])

export function TeamActivityFeed({ events, className }: TeamActivityFeedProps) {
  const [filter, setFilter] = useState<FilterType>('all')

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return events
    if (filter === 'tasks') return events.filter(e => TASK_TYPES.has(e.type))
    if (filter === 'messages') return events.filter(e => MESSAGE_TYPES.has(e.type))
    return events.filter(e => !TASK_TYPES.has(e.type) && !MESSAGE_TYPES.has(e.type))
  }, [events, filter])

  // Implements REQ-001: direction-aware scroll anchor prevents snap-back
  const { viewportRef, endRef, isScrolledUp, scrollToBottom } = useScrollAnchor({
    contentLength: filteredEvents.length,
    resetKey: filter,
  })

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Filter bar */}
      <div className="flex items-center gap-1 px-3 py-2 border-b border-border">
        {FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            type="button"
            onClick={() => setFilter(opt.id)}
            className={cn(
              'px-2 py-1 text-xs rounded-md transition-colors',
              filter === opt.id
                ? 'bg-foreground/5 text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.02]'
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div className="relative flex-1 min-h-0">
        <ScrollArea className="h-full" viewportRef={viewportRef}>
          <div className="p-3 space-y-1">
            {filteredEvents.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <p className="text-xs">No activity yet</p>
              </div>
            ) : (
              filteredEvents.map((event) => {
                const config = EVENT_CONFIG[event.type] || EVENT_CONFIG.error
                const EventIcon = config.icon

                return (
                  <div
                    key={event.id}
                    className="flex items-start gap-2.5 py-1.5 group"
                  >
                    <EventIcon className={cn('size-3.5 mt-0.5 shrink-0', config.color)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        {event.teammateName && (
                          <span className="text-xs font-medium">{event.teammateName}</span>
                        )}
                        <span className="text-xs text-muted-foreground flex-1 whitespace-pre-wrap break-words">
                          {event.details}
                        </span>
                        <span className="text-[10px] text-muted-foreground/50 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          {new Date(event.timestamp).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              })
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        {/* Jump-to-bottom indicator */}
        {isScrolledUp && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full
                       bg-foreground/10 hover:bg-foreground/20 backdrop-blur-sm
                       px-3 py-1.5 text-xs text-foreground/80 shadow-md transition-all"
          >
            <ArrowDown className="size-3" />
            New activity
          </button>
        )}
      </div>
    </div>
  )
}
