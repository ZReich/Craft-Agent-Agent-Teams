/**
 * TeamHeader
 *
 * Header bar for the team dashboard showing team name, status,
 * active teammate count, delegate mode toggle, and cost tracker.
 */

import * as React from 'react'
import { Users, DollarSign, Shield, ShieldOff, Columns2, PanelLeftClose } from 'lucide-react'
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
  isCompactSidebarMode?: boolean
  onToggleCompactSidebarMode?: () => void
}

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  active: { label: 'Active', className: 'bg-green-500/10 text-green-600 border-green-500/20' },
  'cleaning-up': { label: 'Cleaning Up', className: 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20' },
  completed: { label: 'Completed', className: 'bg-foreground/5 text-muted-foreground border-border' },
  error: { label: 'Error', className: 'bg-red-500/10 text-red-600 border-red-500/20' },
}

export function TeamHeader({
  team,
  cost,
  onToggleDelegateMode,
  onCleanupTeam,
  specModeEnabled,
  isCompactSidebarMode,
  onToggleCompactSidebarMode,
}: TeamHeaderProps) {
  const activeCount = team.members.filter(m => m.status === 'working' || m.status === 'idle' || m.status === 'planning').length
  const statusInfo = STATUS_LABELS[team.status] || STATUS_LABELS.active

  return (
    <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-background/50">
      <div className="flex items-center gap-3 min-w-0">
        <h2 className="text-sm font-semibold truncate">{team.name}</h2>
        <Badge variant="outline" className={cn('text-[11px] px-1.5 py-0', statusInfo.className)}>
          {statusInfo.label}
        </Badge>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" />
          <span>{activeCount}/{team.members.length}</span>
        </div>
        {specModeEnabled && (
          <Badge variant="outline" className="text-[11px] px-1.5 py-0 border-blue-500/30 text-blue-500">
            Spec Compliance
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {onToggleCompactSidebarMode && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleCompactSidebarMode}
            className={cn('h-7 gap-1 text-xs', isCompactSidebarMode && 'text-blue-500')}
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
            'h-7 gap-1 text-xs',
            team.delegateMode && 'text-blue-500'
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
