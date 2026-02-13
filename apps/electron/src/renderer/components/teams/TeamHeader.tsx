/**
 * TeamHeader
 *
 * Header bar for the team dashboard showing team name, status,
 * active teammate count, delegate mode toggle, and cost tracker.
 */

import * as React from 'react'
import { Users, DollarSign, Shield, ShieldOff, Columns2, PanelLeftClose, LayoutGrid, MessageSquare } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentTeam, TeamCostSummary } from '../../../shared/types'

export interface TeamHeaderProps {
  team: AgentTeam
  cost?: TeamCostSummary
  onToggleDelegateMode?: () => void
  onCleanupTeam?: () => void
  specModeEnabled?: boolean
  specLabel?: string
  isCompactSidebarMode?: boolean
  onToggleCompactSidebarMode?: () => void
  viewMode?: 'overview' | 'focus'
  onViewModeChange?: (mode: 'overview' | 'focus') => void
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-success/10 text-success-text border-success/20' },
  'cleaning-up': { label: 'Cleaning Up', className: 'bg-info/10 text-info-text border-info/20' },
  completed: { label: 'Completed', className: 'bg-foreground/5 text-muted-foreground border-border' },
  error: { label: 'Error', className: 'bg-destructive/10 text-destructive-text border-destructive/20' },
}

export function TeamHeader({
  team,
  cost,
  onToggleDelegateMode,
  onCleanupTeam,
  specModeEnabled,
  specLabel,
  isCompactSidebarMode,
  onToggleCompactSidebarMode,
  viewMode = 'overview',
  onViewModeChange,
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
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" />
          <span>{activeCount}/{team.members.length}</span>
        </div>
        {specModeEnabled && (
          <Badge variant="outline" className="text-[11px] px-2 py-0.5 font-medium border-accent/30 text-accent">
            Spec Compliance
          </Badge>
        )}
        {specModeEnabled && specLabel && (
          <span className="text-[11px] text-muted-foreground truncate max-w-[240px]" title={specLabel}>
            {specLabel}
          </span>
        )}
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
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <DollarSign className="size-3" />
            <span>${cost.totalCostUsd.toFixed(2)}</span>
          </div>
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
