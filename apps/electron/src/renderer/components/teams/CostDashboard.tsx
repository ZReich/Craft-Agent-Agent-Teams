/**
 * CostDashboard
 *
 * Real-time cost tracking panel showing:
 * - Per-teammate token counter and cost
 * - Per-model breakdown
 * - Aggregate team spend
 * - Cost comparison (current vs all-Opus estimate)
 * - Warning at configurable thresholds
 */

import * as React from 'react'
import { DollarSign, AlertTriangle, TrendingDown } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { TeamCostSummary, AgentTeammate } from '../../../shared/types'

export interface CostDashboardProps {
  cost: TeamCostSummary
  teammates: AgentTeammate[]
  className?: string
}

// Model display names
const MODEL_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'kimi-k2.5': 'Kimi K2.5',
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(0)}K`
  return String(count)
}

export function CostDashboard({ cost, teammates, className }: CostDashboardProps) {
  const savingsPercent = cost.allOpusEstimateUsd
    ? Math.round((1 - cost.totalCostUsd / cost.allOpusEstimateUsd) * 100)
    : 0

  const capPercent = cost.costCapUsd
    ? Math.min(100, Math.round((cost.totalCostUsd / cost.costCapUsd) * 100))
    : 0

  return (
    <div className={cn('flex flex-col h-full', className)}>
      {/* Summary header */}
      <div className="px-4 py-3 border-b border-border space-y-3">
        {/* Total cost */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="size-4 text-muted-foreground" />
            <span className="text-sm font-medium">Total Cost</span>
          </div>
          <span className="text-lg font-semibold">${cost.totalCostUsd.toFixed(2)}</span>
        </div>

        {/* Savings vs all-Opus */}
        {cost.allOpusEstimateUsd && savingsPercent > 0 && (
          <div className="flex items-center gap-2 text-xs text-green-600">
            <TrendingDown className="size-3" />
            <span>
              Saving {savingsPercent}% vs all-Opus (${cost.allOpusEstimateUsd.toFixed(2)})
            </span>
          </div>
        )}

        {/* Cost cap progress */}
        {cost.costCapUsd && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                Budget: ${cost.costCapUsd.toFixed(2)}
              </span>
              <span className={cn(
                capPercent >= 90 ? 'text-destructive' :
                capPercent >= 75 ? 'text-yellow-500' : 'text-muted-foreground'
              )}>
                {capPercent}%
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-foreground/10 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  capPercent >= 90 ? 'bg-destructive' :
                  capPercent >= 75 ? 'bg-yellow-500' : 'bg-green-500'
                )}
                style={{ width: `${capPercent}%` }}
              />
            </div>
            {cost.costCapReached && (
              <div className="flex items-center gap-1 text-xs text-destructive">
                <AlertTriangle className="size-3" />
                Cost cap reached
              </div>
            )}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="p-4 space-y-5">
          {/* Per-teammate breakdown */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              By Teammate
            </h4>
            <div className="space-y-1.5">
              {teammates.map((tm) => {
                const usage = cost.perTeammate[tm.id]
                if (!usage) return null

                return (
                  <div key={tm.id} className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-sm truncate">{tm.name}</span>
                      <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                        {MODEL_NAMES[tm.model] || tm.model}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
                      <span>{formatTokens(usage.inputTokens)} in</span>
                      <span>{formatTokens(usage.outputTokens)} out</span>
                      <span className="font-medium text-foreground">${usage.costUsd.toFixed(2)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Per-model breakdown */}
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              By Model
            </h4>
            <div className="space-y-1.5">
              {Object.entries(cost.perModel).map(([modelId, usage]) => (
                <div key={modelId} className="flex items-center justify-between py-1">
                  <span className="text-sm">{MODEL_NAMES[modelId] || modelId}</span>
                  <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
                    <span>{formatTokens(usage.inputTokens)} in</span>
                    <span>{formatTokens(usage.outputTokens)} out</span>
                    <span className="font-medium text-foreground">${usage.costUsd.toFixed(2)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
