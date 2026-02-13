/**
 * TeamCard
 *
 * Card component for displaying team summary in a grid layout.
 * Shows team name, member count, status, and quick actions.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Users, Activity, CheckCircle2, Loader2, AlertCircle, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { AgentTeam, AgentTeammateStatus } from '../../../shared/types'

export interface TeamCardProps {
  /** Team data */
  team: AgentTeam
  /** Whether this card is selected */
  isSelected?: boolean
  /** Click handler */
  onClick?: () => void
  /** Optional cost data */
  cost?: {
    totalCostUsd: number
  }
  /** Optional className */
  className?: string
}

const STATUS_CONFIG: Record<AgentTeammateStatus, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className: string
  animate?: boolean
}> = {
  spawning: { icon: Loader2, label: 'Spawning', className: 'text-blue-500', animate: true },
  working: { icon: Loader2, label: 'Working', className: 'text-green-500', animate: true },
  idle: { icon: CheckCircle2, label: 'Idle', className: 'text-muted-foreground' },
  planning: { icon: Activity, label: 'Planning', className: 'text-purple-500' },
  'awaiting-approval': { icon: AlertCircle, label: 'Awaiting Approval', className: 'text-yellow-500' },
  error: { icon: AlertCircle, label: 'Error', className: 'text-destructive' },
  shutdown: { icon: CheckCircle2, label: 'Shutdown', className: 'text-muted-foreground' },
}

export function TeamCard({
  team,
  isSelected = false,
  onClick,
  cost,
  className,
}: TeamCardProps) {
  const activeMembers = team.members.filter(m =>
    m.status === 'working' || m.status === 'planning'
  ).length
  const totalMembers = team.members.length

  // Get dominant status for team indicator
  const workingCount = team.members.filter(m => m.status === 'working').length
  const planningCount = team.members.filter(m => m.status === 'planning').length
  const errorCount = team.members.filter(m => m.status === 'error').length

  let teamStatus: AgentTeammateStatus = 'idle'
  if (errorCount > 0) teamStatus = 'error'
  else if (workingCount > 0) teamStatus = 'working'
  else if (planningCount > 0) teamStatus = 'planning'

  const statusConfig = STATUS_CONFIG[teamStatus]
  const StatusIcon = statusConfig.icon

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col p-4 rounded-lg bg-background text-left transition-all shadow-tinted hover:shadow-middle',
        isSelected && 'ring-2 ring-accent',
        teamStatus === 'working' && 'bg-accent/[0.03]',
        className
      )}
      style={{ '--shadow-color': 'var(--accent-rgb)' } as React.CSSProperties}
    >
      {/* Status indicator */}
      <div className="absolute top-3 right-3">
        <StatusIcon
          className={cn(
            'size-4',
            statusConfig.className,
            statusConfig.animate && 'animate-spin'
          )}
        />
      </div>

      {/* Team name */}
      <div className="mb-3 pr-8">
        <h3 className="font-semibold text-base truncate">{team.name}</h3>
        {team.delegateMode && (
          <Badge variant="secondary" className="mt-1 text-[10px] px-1.5 py-0 h-4">
            Delegate Mode
          </Badge>
        )}
      </div>

      {/* Stats */}
      <div className="flex flex-col gap-2 mt-auto">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Users className="size-3.5" />
          <span>
            {activeMembers > 0 ? (
              <>{activeMembers} of {totalMembers} active</>
            ) : (
              <>{totalMembers} {totalMembers === 1 ? 'member' : 'members'}</>
            )}
          </span>
        </div>

        {cost && cost.totalCostUsd > 0 && (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <DollarSign className="size-3.5" />
            <span>${cost.totalCostUsd.toFixed(3)}</span>
          </div>
        )}

        <Badge
          variant={teamStatus === 'error' ? 'destructive' : 'secondary'}
          className={cn(
            'text-[10px]',
            teamStatus === 'working' && 'bg-success/10 text-success-text border-transparent',
            teamStatus === 'planning' && 'bg-info/10 text-info-text border-transparent',
          )}
        >
          {statusConfig.label}
        </Badge>
      </div>
    </button>
  )
}
