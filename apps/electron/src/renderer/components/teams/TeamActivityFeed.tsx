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
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
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
  'task-completed': { icon: CheckCircle2, color: 'text-green-500' },
  'task-failed': { icon: AlertCircle, color: 'text-destructive' },
  'message-sent': { icon: MessageSquare, color: 'text-foreground/70' },
  'plan-submitted': { icon: ClipboardList, color: 'text-purple-500' },
  'plan-approved': { icon: ThumbsUp, color: 'text-green-500' },
  'plan-rejected': { icon: ThumbsDown, color: 'text-yellow-500' },
  'model-swapped': { icon: RefreshCw, color: 'text-blue-500' },
  'escalation': { icon: ArrowUpCircle, color: 'text-yellow-500' },
  'cost-warning': { icon: DollarSign, color: 'text-yellow-500' },
  'error': { icon: AlertTriangle, color: 'text-destructive' },
}

type FilterType = 'all' | 'tasks' | 'messages' | 'system'

const FILTER_OPTIONS: { id: FilterType; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'messages', label: 'Messages' },
  { id: 'system', label: 'System' },
]

const TASK_TYPES = new Set<TeamActivityType>(['task-claimed', 'task-completed', 'task-failed'])
const MESSAGE_TYPES = new Set<TeamActivityType>(['message-sent', 'plan-submitted', 'plan-approved', 'plan-rejected'])

export function TeamActivityFeed({ events, className }: TeamActivityFeedProps) {
  const [filter, setFilter] = useState<FilterType>('all')
  // Implements REQ-001, REQ-002: keep activity feed anchored to bottom when appropriate
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const endRef = React.useRef<HTMLDivElement>(null)
  const isStickToBottomRef = React.useRef(true)
  const skipSmoothUntilRef = React.useRef(0)

  const filteredEvents = useMemo(() => {
    if (filter === 'all') return events
    if (filter === 'tasks') return events.filter(e => TASK_TYPES.has(e.type))
    if (filter === 'messages') return events.filter(e => MESSAGE_TYPES.has(e.type))
    return events.filter(e => !TASK_TYPES.has(e.type) && !MESSAGE_TYPES.has(e.type))
  }, [events, filter])

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior) => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' })
  }, [])

  // Scroll to bottom on mount/filter change (instant to avoid visible jump)
  React.useLayoutEffect(() => {
    scrollToBottom('instant')
    isStickToBottomRef.current = true
    skipSmoothUntilRef.current = Date.now() + 400
  }, [filter, scrollToBottom])

  // Track scroll position to toggle sticky behavior
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      isStickToBottomRef.current = distanceFromBottom < 20
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll on new events only when user is at bottom
  React.useEffect(() => {
    if (!isStickToBottomRef.current) return
    if (Date.now() < skipSmoothUntilRef.current) return
    scrollToBottom('smooth')
  }, [filteredEvents.length, scrollToBottom])

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
      <ScrollArea className="flex-1 min-h-0" viewportRef={viewportRef}>
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
                      <span className="text-xs text-muted-foreground flex-1 truncate">
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
    </div>
  )
}
