/**
 * UsageSettingsPage
 *
 * Settings page showing API usage and cost tracking:
 * - Current session stats (tokens, calls, cost)
 * - Weekly usage summary
 * - Provider breakdown
 * - Export usage data
 */

import * as React from 'react'
import { useState, useEffect, useCallback } from 'react'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { routes } from '@/lib/navigate'
import { Spinner } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import { Download, RefreshCw, Zap, TrendingUp, DollarSign, Clock } from 'lucide-react'
import type { DetailsPageMeta } from '@/lib/navigation-registry'
import type { SessionUsage, WeeklyUsageSummary } from '../../../shared/types'

import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'usage',
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
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

export default function UsageSettingsPage() {
  const [weeklyUsage, setWeeklyUsage] = useState<WeeklyUsageSummary | null>(null)
  const [recentWeeks, setRecentWeeks] = useState<WeeklyUsageSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isExporting, setIsExporting] = useState(false)

  const loadUsage = useCallback(async () => {
    try {
      const api = window.electronAPI
      if (!api?.getWeeklyUsage) {
        setIsLoading(false)
        return
      }
      const [weekly, recent] = await Promise.all([
        api.getWeeklyUsage(),
        api.getRecentWeeksUsage?.(4) ?? [],
      ])
      if (weekly) setWeeklyUsage(weekly)
      if (recent) setRecentWeeks(recent)
    } catch (err) {
      console.error('Failed to load usage:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadUsage()
  }, [loadUsage])

  // Listen for real-time updates
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onUsageCostUpdate) return
    const cleanup = api.onUsageCostUpdate(() => {
      // Refresh weekly data when any session updates
      loadUsage()
    })
    return cleanup
  }, [loadUsage])

  const handleExport = useCallback(async () => {
    if (!weeklyUsage) return
    setIsExporting(true)
    try {
      const api = window.electronAPI
      if (!api?.exportUsageCSV) return

      // Build CSV
      const rows = [
        ['Period', 'Sessions', 'API Calls', 'Input Tokens', 'Output Tokens', 'Estimated Cost (USD)'],
        [
          'This Week',
          String(weeklyUsage.sessionCount),
          String(weeklyUsage.totals?.calls ?? 0),
          String(weeklyUsage.totals?.inputTokens ?? 0),
          String(weeklyUsage.totals?.outputTokens ?? 0),
          formatCost(weeklyUsage.totals?.estimatedCostUsd ?? 0),
        ],
      ]
      const csv = rows.map(r => r.join(',')).join('\n')
      await api.exportUsageCSV(csv)
    } catch (err) {
      console.error('Export failed:', err)
    } finally {
      setIsExporting(false)
    }
  }, [weeklyUsage])

  const weeklyTokensIn = weeklyUsage?.totals?.inputTokens ?? 0
  const weeklyTokensOut = weeklyUsage?.totals?.outputTokens ?? 0
  const weeklyCalls = weeklyUsage?.totals?.calls ?? 0
  const weeklyCost = weeklyUsage?.totals?.estimatedCostUsd ?? 0
  const weeklySessionCount = weeklyUsage?.sessionCount ?? 0

  return (
    <div className="h-full flex flex-col">
      <PanelHeader
        title="Usage"
        actions={<HeaderMenu route={routes.view.settings('usage')} />}
      />

      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Spinner className="size-5" />
              </div>
            ) : (
              <div className="space-y-8">
                {/* This Week Overview */}
                <SettingsSection title="This Week">
                  <SettingsCard>
                    <SettingsRow label="Sessions">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="gap-1">
                          <TrendingUp className="size-3" />
                          {weeklySessionCount}
                        </Badge>
                      </div>
                    </SettingsRow>
                    <SettingsRow label="API Calls">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="gap-1">
                          <Zap className="size-3" />
                          {weeklyCalls.toLocaleString()}
                        </Badge>
                      </div>
                    </SettingsRow>
                    <SettingsRow label="Tokens Used">
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-muted-foreground">
                          In: <span className="text-foreground font-medium">{formatTokens(weeklyTokensIn)}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Out: <span className="text-foreground font-medium">{formatTokens(weeklyTokensOut)}</span>
                        </span>
                        <span className="text-muted-foreground">
                          Total: <span className="text-foreground font-medium">{formatTokens(weeklyTokensIn + weeklyTokensOut)}</span>
                        </span>
                      </div>
                    </SettingsRow>
                    {weeklyCost > 0 && (
                      <SettingsRow label="Estimated Cost">
                        <div className="flex items-center gap-2">
                          <Badge variant="secondary" className="gap-1">
                            <DollarSign className="size-3" />
                            {formatCost(weeklyCost)}
                          </Badge>
                        </div>
                      </SettingsRow>
                    )}
                  </SettingsCard>
                </SettingsSection>

                {/* Per-Provider Breakdown */}
                {weeklyUsage?.providerBreakdown && Object.keys(weeklyUsage.providerBreakdown).length > 0 && (
                  <SettingsSection title="By Provider">
                    <SettingsCard>
                      {Object.entries(weeklyUsage.providerBreakdown).map(([provider, usage]) => (
                        <SettingsRow key={provider} label={PROVIDER_NAMES[provider] || provider}>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span>{formatTokens(usage.inputTokens)} in</span>
                            <span>{formatTokens(usage.outputTokens)} out</span>
                            <span>{usage.callCount} calls</span>
                            {usage.estimatedCostUsd > 0 && (
                              <span className="font-medium text-foreground">
                                {formatCost(usage.estimatedCostUsd)}
                              </span>
                            )}
                          </div>
                        </SettingsRow>
                      ))}
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* Recent Weeks */}
                {recentWeeks.length > 0 && (
                  <SettingsSection title="Recent Weeks">
                    <SettingsCard>
                      {recentWeeks.map((week, i) => (
                        <SettingsRow key={week.startDate || i} label={week.startDate ? new Date(week.startDate).toLocaleDateString() : `Week ${i + 1}`}>
                          <div className="flex items-center gap-3 text-sm text-muted-foreground">
                            <span>{week.sessionCount} sessions</span>
                            <span>{formatTokens((week.totals?.inputTokens ?? 0) + (week.totals?.outputTokens ?? 0))} tokens</span>
                            {(week.totals?.estimatedCostUsd ?? 0) > 0 && (
                              <span className="font-medium text-foreground">
                                {formatCost(week.totals?.estimatedCostUsd ?? 0)}
                              </span>
                            )}
                          </div>
                        </SettingsRow>
                      ))}
                    </SettingsCard>
                  </SettingsSection>
                )}

                {/* Actions */}
                <SettingsSection title="Data">
                  <SettingsCard>
                    <SettingsRow label="Export usage data">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleExport}
                        disabled={isExporting || !weeklyUsage}
                        className="gap-1.5"
                      >
                        {isExporting ? (
                          <Spinner className="size-3" />
                        ) : (
                          <Download className="size-3" />
                        )}
                        Export CSV
                      </Button>
                    </SettingsRow>
                    <SettingsRow label="Refresh usage data">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={loadUsage}
                        className="gap-1.5"
                      >
                        <RefreshCw className="size-3" />
                        Refresh
                      </Button>
                    </SettingsRow>
                  </SettingsCard>
                </SettingsSection>

                {/* Empty state */}
                {!weeklyUsage && (
                  <div className="text-center py-8 text-muted-foreground">
                    <Zap className="size-8 mx-auto mb-3 opacity-40" />
                    <p className="text-sm">No usage data yet.</p>
                    <p className="text-xs mt-1">Usage will appear here as you use AI sessions.</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
