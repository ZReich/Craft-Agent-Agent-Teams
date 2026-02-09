import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ChevronRight,
  ChevronLeft,
  Activity,
  ClipboardList,
  AlertTriangle,
  MessageSquare,
  CheckCircle2,
  Bot,
} from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@craft-agent/ui'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

export interface TeamSidebarCompactProps {
  teammates: Array<{ id: string; name: string; status: string; currentTask?: string; model: string }>
  activeTasks: number
  specCoverage: number
  recentActivity: Array<{ id: string; type: string; details: string; timestamp: string }>
  isExpanded: boolean
  onToggleExpand: () => void
  className?: string
}

function statusDotClass(status: string): string {
  switch (status) {
    case 'working':
      return 'bg-green-500'
    case 'idle':
    case 'planning':
      return 'bg-yellow-500'
    case 'error':
      return 'bg-destructive'
    case 'shutdown':
      return 'bg-muted-foreground'
    default:
      return 'bg-muted-foreground'
  }
}

function activityMeta(type: string) {
  if (type.includes('task')) return { icon: ClipboardList, color: 'text-blue-500' }
  if (type.includes('error') || type.includes('fail')) return { icon: AlertTriangle, color: 'text-destructive' }
  if (type.includes('message') || type.includes('plan')) return { icon: MessageSquare, color: 'text-muted-foreground' }
  return { icon: Activity, color: 'text-foreground/70' }
}

function formatRelativeTime(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '--'

  const diffMs = Date.now() - date.getTime()
  const sec = Math.round(diffMs / 1000)
  if (Math.abs(sec) < 60) return `${sec}s`

  const min = Math.round(sec / 60)
  if (Math.abs(min) < 60) return `${min}m`

  const hrs = Math.round(min / 60)
  if (Math.abs(hrs) < 24) return `${hrs}h`

  const days = Math.round(hrs / 24)
  return `${days}d`
}

export function TeamSidebarCompact({
  teammates,
  activeTasks,
  specCoverage,
  recentActivity,
  isExpanded,
  onToggleExpand,
  className,
}: TeamSidebarCompactProps) {
  const width = isExpanded ? 280 : 56

  return (
    <TooltipProvider>
      <motion.aside
        animate={{ width }}
        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        className={cn('h-full border-r border-border bg-background/50 overflow-hidden', className)}
        onMouseEnter={() => {
          if (!isExpanded) onToggleExpand()
        }}
        onMouseLeave={() => {
          if (isExpanded) onToggleExpand()
        }}
      >
        <div className="h-full w-[280px] flex flex-col">
          <div className="h-10 px-2 border-b border-border flex items-center justify-between">
            <AnimatePresence initial={false}>
              {isExpanded && (
                <motion.span
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -4 }}
                  className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Team
                </motion.span>
              )}
            </AnimatePresence>

            <button
              type="button"
              onClick={onToggleExpand}
              className="size-7 rounded-md hover:bg-foreground/[0.05] inline-flex items-center justify-center text-muted-foreground"
              title={isExpanded ? 'Collapse sidebar' : 'Expand sidebar'}
            >
              {isExpanded ? <ChevronLeft className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          </div>

          <ScrollArea className="flex-1 min-h-0">
            <div className="p-2 space-y-3">
              <div className="space-y-1">
                {teammates.map((teammate) => {
                  const dotClass = statusDotClass(teammate.status)

                  return (
                    <Tooltip key={teammate.id}>
                      <TooltipTrigger asChild>
                        <div className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-foreground/[0.03]">
                          <span className={cn('size-2 rounded-full shrink-0', dotClass)} />
                          <AnimatePresence initial={false}>
                            {isExpanded && (
                              <motion.div
                                initial={{ opacity: 0, x: -4 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -4 }}
                                className="min-w-0 flex-1"
                              >
                                <div className="text-xs font-medium truncate">{teammate.name}</div>
                                <div className="text-[10px] text-muted-foreground truncate">{teammate.currentTask || teammate.model}</div>
                              </motion.div>
                            )}
                          </AnimatePresence>
                        </div>
                      </TooltipTrigger>
                      {!isExpanded && (
                        <TooltipContent side="right" className="text-xs">
                          {teammate.name}
                        </TooltipContent>
                      )}
                    </Tooltip>
                  )
                })}
              </div>

              <div className="rounded-lg border border-border p-2 bg-background/40">
                <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><ClipboardList className="size-3" />Tasks</span>
                  <span className="font-medium text-foreground">{activeTasks}</span>
                </div>
                <div className="mt-2 text-[10px] text-muted-foreground flex items-center justify-between">
                  <span>Spec Coverage</span>
                  <span className="text-foreground font-medium tabular-nums">{Math.round(specCoverage)}%</span>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full bg-foreground/10 overflow-hidden">
                  <motion.div
                    className="h-full bg-green-500"
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.max(0, Math.min(100, specCoverage))}%` }}
                    transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
                  />
                </div>
              </div>

              <div className="space-y-1">
                <div className="px-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">Recent</div>
                {(recentActivity.slice(0, 5)).map((event) => {
                  const meta = activityMeta(event.type)
                  const EventIcon = meta.icon

                  return (
                    <Tooltip key={event.id}>
                      <TooltipTrigger asChild>
                        <div className="rounded-md px-1.5 py-1 hover:bg-foreground/[0.03]">
                          <div className="flex items-start gap-1.5">
                            <EventIcon className={cn('size-3 mt-0.5 shrink-0', meta.color)} />
                            <div className="min-w-0 flex-1">
                              <p className="text-[11px] text-foreground truncate">{event.details}</p>
                              <p className="text-[10px] text-muted-foreground">{formatRelativeTime(event.timestamp)}</p>
                            </div>
                          </div>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right" className="max-w-xs text-xs">
                        {event.details}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}

                {recentActivity.length === 0 && (
                  <div className="rounded-md px-1.5 py-2 text-[10px] text-muted-foreground">No activity</div>
                )}
              </div>
            </div>
          </ScrollArea>

          <div className="px-2 py-1.5 border-t border-border text-[10px] text-muted-foreground flex items-center justify-between">
            <span className="inline-flex items-center gap-1"><Bot className="size-3" />Teammates</span>
            <Badge variant="outline" className="h-4 text-[10px] px-1.5 py-0">{teammates.length}</Badge>
          </div>
        </div>
      </motion.aside>
    </TooltipProvider>
  )
}
