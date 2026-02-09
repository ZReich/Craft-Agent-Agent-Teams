/**
 * UsageDetailPanel - Detailed expandable usage panel
 *
 * Shows comprehensive session and weekly usage statistics with provider breakdown.
 * Follows the visual style of CostDashboard.tsx.
 */

import * as React from 'react'
import { ChevronDown, ChevronRight, Zap, TrendingUp, Clock, DollarSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useUsageTracking } from '@/hooks/useUsageTracking'
import type { ProviderUsage } from '../../../shared/types'

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

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

const PROVIDER_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  moonshot: 'Moonshot (Kimi)',
  openrouter: 'OpenRouter',
}

export interface UsageDetailPanelProps {
  sessionId?: string
  className?: string
}

export function UsageDetailPanel({ sessionId, className }: UsageDetailPanelProps) {
  const [expanded, setExpanded] = React.useState(false)
  const { sessionUsage, weeklyUsage, metrics, isLoading } = useUsageTracking(sessionId)

  if (isLoading) {
    return (
      <div className={cn('p-4', className)}>
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-muted rounded w-1/3" />
          <div className="h-8 bg-muted rounded" />
          <div className="h-8 bg-muted rounded" />
        </div>
      </div>
    )
  }

  const providers = Object.entries(sessionUsage?.providers ?? {})

  return (
    <div className={cn('flex flex-col', className)}>
      {/* Header toggle */}
      <Button
        variant="ghost"
        onClick={() => setExpanded(!expanded)}
        className="w-full justify-between px-4 py-3 h-auto hover:bg-accent/50"
      >
        <div className="flex items-center gap-2">
          {expanded ? (
            <ChevronDown className="size-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">Usage Details</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Zap className="size-3" />
          {formatTokens(metrics.session.inputTokens + metrics.session.outputTokens)}
          {metrics.session.estimatedCostUsd > 0 && (
            <>
              <DollarSign className="size-3 ml-1" />
              {formatCost(metrics.session.estimatedCostUsd)}
            </>
          )}
        </div>
      </Button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-border">
          <ScrollArea className="max-h-96">
            <div className="p-4 space-y-5">
              {/* Session section */}
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  Current Session
                </h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Zap className="size-3" />
                      <span className="text-xs">API Calls</span>
                    </div>
                    <div className="font-medium">{metrics.session.calls}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <Clock className="size-3" />
                      <span className="text-xs">Duration</span>
                    </div>
                    <div className="font-medium">{formatDuration(metrics.session.durationMs)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Input Tokens</div>
                    <div className="font-medium">{formatTokens(metrics.session.inputTokens)}</div>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs text-muted-foreground">Output Tokens</div>
                    <div className="font-medium">{formatTokens(metrics.session.outputTokens)}</div>
                  </div>
                  {metrics.session.estimatedCostUsd > 0 && (
                    <div className="col-span-2 space-y-1">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <DollarSign className="size-3" />
                        <span className="text-xs">Estimated Cost</span>
                      </div>
                      <div className="font-medium text-lg">
                        {formatCost(metrics.session.estimatedCostUsd)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Weekly section */}
              {weeklyUsage && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    This Week
                  </h4>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 text-muted-foreground">
                        <TrendingUp className="size-3" />
                        <span className="text-xs">Sessions</span>
                      </div>
                      <div className="font-medium">{metrics.weekly.sessionCount}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">API Calls</div>
                      <div className="font-medium">{metrics.weekly.calls}</div>
                    </div>
                    <div className="space-y-1">
                      <div className="text-xs text-muted-foreground">Total Tokens</div>
                      <div className="font-medium">
                        {formatTokens(metrics.weekly.inputTokens + metrics.weekly.outputTokens)}
                      </div>
                    </div>
                    {metrics.weekly.estimatedCostUsd > 0 && (
                      <div className="space-y-1">
                        <div className="text-xs text-muted-foreground">Total Cost</div>
                        <div className="font-medium">
                          {formatCost(metrics.weekly.estimatedCostUsd)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Provider breakdown */}
              {providers.length > 0 && (
                <div className="space-y-2">
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    By Provider
                  </h4>
                  <div className="space-y-1.5">
                    {(providers as [string, ProviderUsage][]).map(([providerKey, usage]) => (
                      <div key={providerKey} className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm">
                            {PROVIDER_NAMES[providerKey] || providerKey}
                          </span>
                          <Badge variant="outline" className="text-[10px] px-1 py-0 h-4">
                            {usage.callCount} calls
                          </Badge>
                        </div>
                        <div className="flex items-center gap-3 shrink-0 text-xs text-muted-foreground">
                          <span>{formatTokens(usage.inputTokens)} in</span>
                          <span>{formatTokens(usage.outputTokens)} out</span>
                          {usage.estimatedCostUsd > 0 && (
                            <span className="font-medium text-foreground">
                              {formatCost(usage.estimatedCostUsd)}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  )
}
