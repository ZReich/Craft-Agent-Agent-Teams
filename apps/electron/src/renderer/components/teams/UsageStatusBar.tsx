/**
 * UsageStatusBar - Compact usage indicator for team header
 *
 * Displays session tokens, weekly usage, cost, and team cost in a compact badge format.
 * Follows the visual style of existing team components.
 */

import * as React from 'react'
import { Zap, TrendingUp, DollarSign, Users } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { useUsageTracking } from '@/hooks/useUsageTracking'

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`
  return String(count)
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export interface UsageStatusBarProps {
  sessionId?: string
  className?: string
}

export function UsageStatusBar({ sessionId, className }: UsageStatusBarProps) {
  const { metrics, isLoading } = useUsageTracking(sessionId)

  // Don't render anything during initial load or if there's no data
  if (isLoading) {
    return null
  }

  // Don't render if there's no meaningful data to show
  const hasData =
    metrics.session.calls > 0 ||
    metrics.session.inputTokens > 0 ||
    metrics.session.outputTokens > 0 ||
    metrics.weekly.sessionCount > 0

  if (!hasData) {
    return null
  }

  return (
    <TooltipProvider>
      <div className={cn('flex items-center gap-2 text-xs', className)}>
        {/* Session tokens */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-5">
              <Zap className="size-3" />
              {formatTokens(metrics.session.inputTokens + metrics.session.outputTokens)}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-xs space-y-0.5">
              <div className="font-medium">Session Tokens</div>
              <div>In: {formatTokens(metrics.session.inputTokens)}</div>
              <div>Out: {formatTokens(metrics.session.outputTokens)}</div>
              <div>Calls: {metrics.session.calls}</div>
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Weekly usage */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-5">
              <TrendingUp className="size-3" />
              {metrics.weekly.sessionCount} this week
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <div className="text-xs space-y-0.5">
              <div className="font-medium">This Week</div>
              <div>Sessions: {metrics.weekly.sessionCount}</div>
              <div>
                Tokens: {formatTokens(metrics.weekly.inputTokens + metrics.weekly.outputTokens)}
              </div>
              <div>Calls: {metrics.weekly.calls}</div>
              {metrics.weekly.estimatedCostUsd > 0 && (
                <div>Cost: {formatCost(metrics.weekly.estimatedCostUsd)}</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>

        {/* Cost (if any) */}
        {metrics.session.estimatedCostUsd > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="outline" className="gap-1 text-[10px] px-1.5 py-0 h-5">
                <DollarSign className="size-3" />
                {formatCost(metrics.session.estimatedCostUsd)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="text-xs space-y-0.5">
                <div className="font-medium">Session Cost</div>
                <div>API spend: {formatCost(metrics.session.estimatedCostUsd)}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Team cost (if teams active) */}
        {metrics.teamCostUsd !== null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Badge variant="secondary" className="gap-1 text-[10px] px-1.5 py-0 h-5">
                <Users className="size-3" />
                {formatCost(metrics.teamCostUsd)}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="text-xs">
                <div className="font-medium">Agent Team Cost</div>
                <div>Total team spend: {formatCost(metrics.teamCostUsd)}</div>
              </div>
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </TooltipProvider>
  )
}
