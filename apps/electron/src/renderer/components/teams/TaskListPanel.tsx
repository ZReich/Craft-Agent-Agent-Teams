/**
 * TaskListPanel
 *
 * Collapsible bottom panel showing the shared task board.
 * Tasks have status chips, assignee info, and real-time updates.
 * Supports phase-aware grouping when phases are provided.
 */

import * as React from 'react'
import { useMemo } from 'react'
import { ChevronUp, ChevronDown, CheckCircle2, Circle, Loader2, AlertCircle, Ban, SearchCheck, Layers } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { TeamTask, TeamTaskStatus, AgentTeammate, TeamPhase } from '../../../shared/types'

export interface TaskListPanelProps {
  tasks: TeamTask[]
  teammates: AgentTeammate[]
  isCollapsed: boolean
  onToggleCollapsed: () => void
  onAssignTask?: (taskId: string, teammateId: string) => void
  highlightedTaskIds?: string[]
  /** Phase definitions for phase-aware grouping */
  phases?: TeamPhase[]
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

const PHASE_STATUS_STYLES: Record<string, string> = {
  pending: 'text-muted-foreground',
  'in-progress': 'text-blue-500',
  completed: 'text-green-500',
  blocked: 'text-yellow-500',
}

function TaskRow({
  task,
  assigneeName,
  highlighted,
}: {
  task: TeamTask
  assigneeName?: string
  highlighted: boolean
}) {
  const config = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
  const StatusIcon = config.icon

  return (
    <div
      className={cn(
        'flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent',
        'hover:bg-foreground/[0.02] transition-colors',
        highlighted && 'border-blue-500/30 bg-blue-500/5'
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
}

export function TaskListPanel({
  tasks,
  teammates,
  isCollapsed,
  onToggleCollapsed,
  onAssignTask,
  highlightedTaskIds = [],
  phases,
}: TaskListPanelProps) {
  const completedCount = tasks.filter(t => t.status === 'completed').length
  const totalCount = tasks.length
  const inProgressCount = tasks.filter(t => t.status === 'in_progress').length

  const getTeammateName = (id?: string) => {
    if (!id) return undefined
    return teammates.find(t => t.id === id)?.name
  }

  // Group tasks by phase when phases are available
  const phaseGroups = useMemo(() => {
    if (!phases || phases.length === 0) return null

    const phaseTaskMap = new Map<string, TeamTask[]>()
    const ungrouped: TeamTask[] = []

    // Index tasks by their phase field
    for (const task of tasks) {
      if (task.phase) {
        const existing = phaseTaskMap.get(task.phase) || []
        existing.push(task)
        phaseTaskMap.set(task.phase, existing)
      } else {
        ungrouped.push(task)
      }
    }

    // Build ordered phase groups
    const sorted = [...phases].sort((a, b) => a.order - b.order)
    const groups = sorted.map(phase => ({
      phase,
      tasks: phaseTaskMap.get(phase.id) || [],
    }))

    return { groups, ungrouped }
  }, [tasks, phases])

  const phaseCount = phases?.length ?? 0

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
          {phaseCount > 0 && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-accent/20 text-accent gap-1">
              <Layers className="size-2.5" />
              {phaseCount} phases
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
            ) : phaseGroups ? (
              /* Phase-grouped view */
              <>
                {phaseGroups.groups.map(({ phase, tasks: phaseTasks }) => {
                  if (phaseTasks.length === 0) return null
                  const phaseCompleted = phaseTasks.filter(t => t.status === 'completed').length
                  const phaseStyle = PHASE_STATUS_STYLES[phase.status] || PHASE_STATUS_STYLES.pending

                  return (
                    <div key={phase.id} className="mb-1">
                      {/* Phase header */}
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <Layers className={cn('size-3', phaseStyle)} />
                        <span className={cn('text-[11px] font-semibold uppercase tracking-wide', phaseStyle)}>
                          {phase.name}
                        </span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
                          {phaseCompleted}/{phaseTasks.length}
                        </Badge>
                        <Badge
                          variant="outline"
                          className={cn('text-[9px] px-1 py-0 h-3.5', phaseStyle)}
                        >
                          {phase.status}
                        </Badge>
                      </div>
                      {/* Phase tasks */}
                      <div className="pl-3 space-y-0.5">
                        {phaseTasks.map(task => (
                          <TaskRow
                            key={task.id}
                            task={task}
                            assigneeName={getTeammateName(task.assignee)}
                            highlighted={highlightedTaskIds.includes(task.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )
                })}
                {/* Ungrouped tasks (no phase assigned) */}
                {phaseGroups.ungrouped.length > 0 && (
                  <div className="mb-1">
                    <div className="flex items-center gap-2 px-2.5 py-1.5">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Unphased
                      </span>
                      <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5">
                        {phaseGroups.ungrouped.length}
                      </Badge>
                    </div>
                    <div className="pl-3 space-y-0.5">
                      {phaseGroups.ungrouped.map(task => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          assigneeName={getTeammateName(task.assignee)}
                          highlighted={highlightedTaskIds.includes(task.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              /* Flat view (no phases) */
              tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  assigneeName={getTeammateName(task.assignee)}
                  highlighted={highlightedTaskIds.includes(task.id)}
                />
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
