/**
 * TaskListPanel
 *
 * Collapsible bottom panel showing the shared task board.
 * Tasks have status chips, assignee info, and real-time updates.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, CheckCircle2, Circle, Loader2, AlertCircle, Ban, SearchCheck } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TeamTask, TeamTaskStatus, AgentTeammate } from '../../../shared/types'

export interface TaskListPanelProps {
  tasks: TeamTask[]
  teammates: AgentTeammate[]
  isCollapsed: boolean
  onToggleCollapsed: () => void
  onAssignTask?: (taskId: string, teammateId: string) => void
  highlightedTaskIds?: string[]
}

const STATUS_CONFIG: Record<TeamTaskStatus, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className: string
}> = {
  pending: { icon: Circle, label: 'Pending', className: 'text-muted-foreground' },
  in_progress: { icon: Loader2, label: 'In Progress', className: 'text-blue-500' },
  in_review: { icon: SearchCheck, label: 'In Review', className: 'text-purple-500' },
  completed: { icon: CheckCircle2, label: 'Done', className: 'text-green-500' },
  blocked: { icon: Ban, label: 'Blocked', className: 'text-yellow-500' },
  failed: { icon: AlertCircle, label: 'Failed', className: 'text-destructive' },
}

export function TaskListPanel({
  tasks,
  teammates,
  isCollapsed,
  onToggleCollapsed,
  onAssignTask,
  highlightedTaskIds = [],
}: TaskListPanelProps) {
  const completedCount = tasks.filter(t => t.status === 'completed').length
  const totalCount = tasks.length
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length

  const getTeammateName = (id?: string) => {
    if (!id) return undefined
    return teammates.find(t => t.id === id)?.name
  }

  return (
    <div className="border-t border-border bg-background/50">
      {/* Toggle bar */}
      <button
        type="button"
        onClick={onToggleCollapsed}
        className="w-full flex items-center justify-between px-4 py-2 hover:bg-foreground/[0.02] transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Tasks
          </span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
            {completedCount}/{totalCount}
          </Badge>
          {inProgressCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-blue-500/20 text-blue-500">
              {inProgressCount} active
            </Badge>
          )}
        </div>
        {isCollapsed ? (
          <ChevronUp className="size-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3.5 text-muted-foreground" />
        )}
      </button>

      {/* Task list (when expanded) */}
      {!isCollapsed && (
        <ScrollArea className="max-h-64">
          <div className="px-2 pb-2 space-y-0.5">
            {tasks.length === 0 ? (
              <div className="flex items-center justify-center py-6 text-muted-foreground">
                <p className="text-xs">No tasks yet</p>
              </div>
            ) : (
              tasks.map((task) => {
                const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
                const StatusIcon = config.icon
                const assigneeName = getTeammateName(task.assignee)

                return (
                  <div
                    key={task.id}
                    className={cn(
                      'flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent',
                      'hover:bg-foreground/[0.02] transition-colors'
                      ,
                      highlightedTaskIds.includes(task.id) && 'border-blue-500/30 bg-blue-500/5'
                    )}
                  >
                    <StatusIcon
                      className={cn(
                        'size-3.5 shrink-0',
                        config.className,
                        task.status === 'in_progress' && 'animate-spin'
                      )}
                    />

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            'text-sm truncate',
                            task.status === 'completed' && 'line-through text-muted-foreground'
                          )}
                        >
                          {task.title}
                        </span>
                      </div>
                      {task.description && (
                        <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                          {task.description}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      {assigneeName && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
                          {assigneeName}
                        </Badge>
                      )}
                      {task.dependencies && task.dependencies.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          {task.dependencies.length} dep{task.dependencies.length > 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
