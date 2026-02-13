/**
 * TeamCardGrid
 *
 * Responsive grid layout for displaying multiple teams as cards.
 * Supports selection, empty states, and loading states.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'
import { Plus } from 'lucide-react'
import { TeamCard } from './TeamCard'
import { Button } from '@/components/ui/button'
import type { AgentTeam, TeamCostSummary } from '../../../shared/types'

export interface TeamCardGridProps {
  /** Array of teams to display */
  teams: AgentTeam[]
  /** Currently selected team ID */
  selectedTeamId?: string
  /** Called when a team card is clicked */
  onTeamSelect?: (teamId: string) => void
  /** Called when create team button is clicked */
  onCreateTeam?: () => void
  /** Cost data by team ID */
  costByTeam?: Map<string, TeamCostSummary>
  /** Loading state */
  isLoading?: boolean
  /** Empty state message */
  emptyMessage?: string
  /** Optional className */
  className?: string
}

export function TeamCardGrid({
  teams,
  selectedTeamId,
  onTeamSelect,
  onCreateTeam,
  costByTeam,
  isLoading = false,
  emptyMessage = 'No teams yet. Create your first team to get started.',
  className,
}: TeamCardGridProps) {
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center min-h-[300px]', className)}>
        <div className="text-center space-y-3">
          <div className="size-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-sm text-muted-foreground">Loading teams...</p>
        </div>
      </div>
    )
  }

  if (teams.length === 0) {
    return (
      <div className={cn('flex items-center justify-center min-h-[300px]', className)}>
        <div className="text-center space-y-4 max-w-md">
          <div className="size-16 rounded-full bg-foreground/5 flex items-center justify-center mx-auto">
            <Plus className="size-6 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-sm font-semibold mb-1">No Active Teams</h3>
            <p className="text-xs text-muted-foreground">{emptyMessage}</p>
          </div>
          {onCreateTeam && (
            <Button onClick={onCreateTeam} size="sm">
              <Plus className="size-4 mr-1.5" />
              Create Team
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'grid gap-4 auto-rows-fr',
        'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
        className
      )}
    >
      {teams.map((team) => (
        <TeamCard
          key={team.id}
          team={team}
          isSelected={team.id === selectedTeamId}
          onClick={() => onTeamSelect?.(team.id)}
          cost={costByTeam?.get(team.id)}
        />
      ))}

      {/* Create new team card (optional) */}
      {onCreateTeam && (
        <button
          type="button"
          onClick={onCreateTeam}
          className={cn(
            'group flex flex-col items-center justify-center p-6 rounded-lg border-2 border-dashed border-border bg-background text-center transition-all hover:border-foreground/40 hover:bg-foreground/[0.02]',
            'min-h-[160px]'
          )}
        >
          <div className="size-12 rounded-full bg-foreground/5 flex items-center justify-center mb-3 group-hover:bg-foreground/10 transition-colors">
            <Plus className="size-5 text-muted-foreground" />
          </div>
          <span className="text-sm font-medium text-foreground">Create New Team</span>
          <span className="text-xs text-muted-foreground mt-1">Start a new collaboration</span>
        </button>
      )}
    </div>
  )
}
