/**
 * TeamHeader
 *
 * Header bar for the team dashboard showing team name, status,
 * active teammate count, delegate mode toggle, and cost tracker.
 */

import * as React from 'react'
import { Users, DollarSign, Shield, ShieldOff, Columns2, PanelLeftClose, LayoutGrid, MessageSquare, Play, Pause, Square, Zap, OctagonX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentTeam, TeamCostSummary, YoloState, YoloPhase } from '../../../shared/types'

export interface TeamHeaderProps {
  team: AgentTeam
  cost?: TeamCostSummary
  onToggleDelegateMode?: () => void
  onCleanupTeam?: () => void
  specModeEnabled?: boolean
  specLabel?: string
  /** Implements BUG-2: actual spec coverage percentage from compliance report */
  specCoveragePercent?: number
  isCompactSidebarMode?: boolean
  onToggleCompactSidebarMode?: () => void
  viewMode?: 'overview' | 'focus'
  onViewModeChange?: (mode: 'overview' | 'focus') => void
  /** Current YOLO orchestrator state */
  yoloState?: YoloState | null
  /** Called to start YOLO execution */
  onYoloStart?: (objective: string) => void
  /** Called to pause YOLO execution */
  onYoloPause?: () => void
  /** Called to abort YOLO execution */
  onYoloAbort?: () => void
  /** Called to stop all non-lead teammates */
  onStopAllWorkers?: () => void
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success/10 text-success-text border-success/20' },
  'cleaning-up': { label: 'Cleaning Up', className: 'bg-info/10 text-info-text border-info/20' },
  completed: { label: 'Completed', className: 'bg-foreground/5 text-muted-foreground border-border' },
  error: { label: 'Error', className: 'bg-destructive/10 text-destructive-text border-destructive/20' },
}

const YOLO_PHASE_LABELS: Record<YoloPhase, { label: string; className: string }> = {
  idle: { label: 'Idle', className: 'bg-foreground/5 text-muted-foreground border-border' },
  'spec-generation': { label: 'Spec', className: 'bg-info/10 text-info-text border-info/20' },
  'task-decomposition': { label: 'Tasks', className: 'bg-info/10 text-info-text border-info/20' },
  executing: { label: 'Executing', className: 'bg-success/10 text-success-text border-success/20' },
  reviewing: { label: 'Reviewing', className: 'bg-purple-500/10 text-purple-500 border-purple-500/20' },
  remediating: { label: 'Remediating', className: 'bg-warning/10 text-warning-text border-warning/20' },
  'integration-check': { label: 'Integration', className: 'bg-info/10 text-info-text border-info/20' },
  synthesizing: { label: 'Synthesis', className: 'bg-accent/10 text-accent border-accent/20' },
  paused: { label: 'Paused', className: 'bg-warning/10 text-warning-text border-warning/20' },
  completed: { label: 'Completed', className: 'bg-success/10 text-success-text border-success/20' },
  aborted: { label: 'Aborted', className: 'bg-destructive/10 text-destructive-text border-destructive/20' },
}

export function TeamHeader({
  team,
  cost,
  onToggleDelegateMode,
  onCleanupTeam,
  specModeEnabled,
  specLabel,
  specCoveragePercent,
  isCompactSidebarMode,
  onToggleCompactSidebarMode,
  viewMode = 'overview',
  onViewModeChange,
  yoloState,
  onYoloStart,
  onYoloPause,
  onYoloAbort,
  onStopAllWorkers,
}: TeamHeaderProps) {
  const activeCount = team.members.filter(m => m.status === 'working' || m.status === 'idle' || m.status === 'planning').length
  const statusInfo = STATUS_LABELS[team.status] || STATUS_LABELS.active

  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-background/50">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm font-semibold truncate">{team.name}</h2>
        <Badge variant="outline" className={cn('text-[11px] px-2 py-0.5 font-medium', statusInfo.className)}>
          {statusInfo.label}
        </Badge>
        <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
          <Users className="size-3" />
          <span>{activeCount}/{team.members.length}</span>
        </div>
        {/* Implements BUG-2: dynamic spec compliance badge with percentage and color */}
        {specModeEnabled && (
          <Badge variant="outline" className={cn(
            'text-[11px] px-2 py-0.5 font-medium',
            specCoveragePercent !== undefined
              ? specCoveragePercent >= 80
                ? 'bg-success/10 text-success-text border-success/20'
                : specCoveragePercent >= 50
                  ? 'bg-warning/10 text-warning-text border-warning/20'
                  : 'bg-destructive/10 text-destructive-text border-destructive/20'
              : 'border-accent/30 text-accent'
          )}>
            {specCoveragePercent !== undefined ? `Spec: ${specCoveragePercent}%` : 'Spec Compliance'}
          </Badge>
        )}
        {specModeEnabled && specLabel && (
          <span className="text-[11px] text-muted-foreground truncate max-w-[240px]" title={specLabel}>
            {specLabel}
          </span>
        )}
        {yoloState && yoloState.phase !== 'idle' && (() => {
          const phaseInfo = YOLO_PHASE_LABELS[yoloState.phase] || YOLO_PHASE_LABELS.idle
          return (
            <>
              <Badge variant="outline" className={cn('text-[11px] px-2 py-0.5 font-medium gap-1', phaseInfo.className)}>
                <Zap className="size-3" />
                YOLO: {phaseInfo.label}
              </Badge>
              {yoloState.remediationRound > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  R{yoloState.remediationRound}/{yoloState.config.maxRemediationRounds}
                </span>
              )}
            </>
          )
        })()}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onViewModeChange && (
          <div className="flex items-center rounded-md border border-border p-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewModeChange('overview')}
              className={cn('h-7 gap-1.5 text-xs px-2', viewMode === 'overview' && 'bg-foreground/5')}
              title="Command Center"
            >
              <LayoutGrid className="size-3" />
              Command
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onViewModeChange('focus')}
              className={cn('h-7 gap-1.5 text-xs px-2', viewMode === 'focus' && 'bg-foreground/5')}
              title="Focus View"
            >
              <MessageSquare className="size-3" />
              Focus
            </Button>
          </div>
        )}

        {onToggleCompactSidebarMode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCompactSidebarMode}
            className={cn('h-7 gap-1.5 text-xs', isCompactSidebarMode && 'text-accent')}
            title={isCompactSidebarMode ? 'Switch to full sidebar' : 'Switch to compact sidebar'}
          >
            {isCompactSidebarMode ? <Columns2 className="size-3" /> : <PanelLeftClose className="size-3" />}
            {isCompactSidebarMode ? 'Full View' : 'Compact'}
          </Button>
        )}

        {/* Cost */}
        {cost && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <DollarSign className="size-3" />
            <span>${cost.totalCostUsd.toFixed(2)}</span>
          </div>
        )}

        {/* YOLO controls */}
        {onYoloStart && (!yoloState || yoloState.phase === 'idle' || yoloState.phase === 'completed' || yoloState.phase === 'aborted') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onYoloStart(team.name)}
            className="h-7 gap-1.5 text-xs text-success-text hover:text-success-text"
            title="Start autonomous YOLO execution"
          >
            <Play className="size-3" />
            YOLO
          </Button>
        )}
        {onYoloPause && yoloState && yoloState.phase !== 'idle' && yoloState.phase !== 'paused' && yoloState.phase !== 'completed' && yoloState.phase !== 'aborted' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onYoloPause}
            className="h-7 gap-1.5 text-xs text-warning-text hover:text-warning-text"
            title="Pause YOLO execution"
          >
            <Pause className="size-3" />
            Pause
          </Button>
        )}
        {onYoloStart && yoloState?.phase === 'paused' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onYoloStart(yoloState.objective || team.name)}
            className="h-7 gap-1.5 text-xs text-success-text hover:text-success-text"
            title="Resume YOLO execution"
          >
            <Play className="size-3" />
            Resume
          </Button>
        )}
        {onYoloAbort && yoloState && yoloState.phase !== 'idle' && yoloState.phase !== 'completed' && yoloState.phase !== 'aborted' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onYoloAbort}
            className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
            title="Abort YOLO execution"
          >
            <Square className="size-3" />
            Abort
          </Button>
        )}

        {/* Stop all workers */}
        {onStopAllWorkers && team.status === 'active' && team.members.filter(m => !m.isLead).length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onStopAllWorkers}
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-destructive"
            title="Stop all worker teammates"
          >
            <OctagonX className="size-3" />
            Stop All
          </Button>
        )}

        {/* Delegate mode toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleDelegateMode}
          className={cn(
            'h-7 gap-1.5 text-xs',
            team.delegateMode && 'text-accent'
          )}
          title={team.delegateMode ? 'Delegate mode: Lead coordinates only' : 'Enable delegate mode'}
        >
          {team.delegateMode ? <Shield className="size-3" /> : <ShieldOff className="size-3" />}
          {team.delegateMode ? 'Delegating' : 'Delegate'}
        </Button>

        {/* Cleanup */}
        {team.status === 'active' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCleanupTeam}
            className="h-7 text-xs text-muted-foreground hover:text-destructive"
          >
            End Team
          </Button>
        )}
      </div>
    </div>
  )
}
