/**
 * TeamCompletionBanner
 *
 * Shown at the top of the TeamDashboard when team.status === 'completed'.
 * Displays elapsed time, teammate/task stats, optional spec coverage,
 * and an auto-dismiss countdown (30 s) that can be cancelled by clicking.
 *
 * Implements REQ-UX-002.
 */

import * as React from 'react'
import { useState, useEffect, useCallback, useRef } from 'react'
import { CheckCircle2, Clock, Users, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentTeam, TeamTask, TeamCostSummary } from '../../../shared/types'

export interface TeamCompletionBannerProps {
  team: AgentTeam
  tasks: TeamTask[]
  cost?: TeamCostSummary
  specCoveragePercent?: number
  onDismiss: () => void
  className?: string
}

const AUTO_DISMISS_SECONDS = 30

function formatElapsed(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime()
  if (ms < 0) return '0s'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

export function TeamCompletionBanner({
  team,
  tasks,
  cost,
  specCoveragePercent,
  onDismiss,
  className,
}: TeamCompletionBannerProps) {
  const [countdown, setCountdown] = useState(AUTO_DISMISS_SECONDS)
  const [autoDismissActive, setAutoDismissActive] = useState(true)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Auto-dismiss countdown
  useEffect(() => {
    if (!autoDismissActive) return

    intervalRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          onDismiss()
          return 0
        }
        return prev - 1
      })
    }, 1000)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [autoDismissActive, onDismiss])

  const cancelAutoDismiss = useCallback(() => {
    setAutoDismissActive(false)
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  // Compute stats
  const nonLeadMembers = team.members.filter((m) => !m.isLead)
  const completedCount = nonLeadMembers.filter(
    (m) => m.status === 'shutdown' || m.status === 'idle'
  ).length
  const failedCount = nonLeadMembers.filter((m) => m.status === 'error').length

  const completedTasks = tasks.filter((t) => t.status === 'completed').length
  const totalTasks = tasks.length

  const elapsed = formatElapsed(team.createdAt)

  return (
    <div
      role="banner"
      onClick={cancelAutoDismiss}
      className={cn(
        'relative rounded-lg border border-success/30 bg-success/[0.06] px-4 py-3 cursor-pointer',
        className,
      )}
    >
      {/* Header row */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <CheckCircle2 className="size-4 text-success-text shrink-0" />
          <h3 className="text-[13px] font-semibold text-success-text truncate">
            Team completed in {elapsed}
          </h3>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="shrink-0 size-6 text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation()
            onDismiss()
          }}
        >
          <X className="size-3.5" />
        </Button>
      </div>

      {/* Stats row */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="text-[11px] px-2 py-0.5 gap-1 bg-success/10 text-success-text border-success/20"
        >
          <Users className="size-3" />
          {completedCount} completed{failedCount > 0 ? `, ${failedCount} failed` : ''}
        </Badge>

        <Badge
          variant="outline"
          className="text-[11px] px-2 py-0.5 gap-1 bg-success/10 text-success-text border-success/20"
        >
          {completedTasks}/{totalTasks} tasks done
        </Badge>

        {specCoveragePercent !== undefined && (
          <Badge
            variant="outline"
            className={cn(
              'text-[11px] px-2 py-0.5',
              specCoveragePercent >= 80
                ? 'bg-success/10 text-success-text border-success/20'
                : specCoveragePercent >= 50
                  ? 'bg-warning/10 text-warning-text border-warning/20'
                  : 'bg-destructive/10 text-destructive-text border-destructive/20',
            )}
          >
            Spec: {specCoveragePercent}%
          </Badge>
        )}

        {cost && (
          <Badge
            variant="outline"
            className="text-[11px] px-2 py-0.5 text-muted-foreground"
          >
            ${cost.totalCostUsd.toFixed(2)}
          </Badge>
        )}

        <span className="text-[11px] text-muted-foreground flex items-center gap-1">
          <Clock className="size-3" />
          {elapsed}
        </span>
      </div>

      {/* Auto-dismiss countdown */}
      {autoDismissActive && (
        <p className="mt-1.5 text-[10px] text-muted-foreground/70">
          Auto-closing in {countdown}s... (click to cancel)
        </p>
      )}
    </div>
  )
}
