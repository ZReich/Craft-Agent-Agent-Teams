/**
 * useUsageTracking - Hook for fetching and tracking usage data
 *
 * Fetches session and weekly usage data via IPC and listens for real-time updates.
 */

import { useState, useEffect, useCallback } from 'react'
import type { SessionUsage, WeeklyUsageSummary, UsageAlert } from '../../../shared/types'

export interface UsageMetrics {
  session: {
    calls: number
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    durationMs: number
  }
  weekly: {
    sessionCount: number
    calls: number
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
  }
  teamCostUsd: number | null
}

export function useUsageTracking(sessionId?: string) {
  const [sessionUsage, setSessionUsage] = useState<SessionUsage | null>(null)
  const [weeklyUsage, setWeeklyUsage] = useState<WeeklyUsageSummary | null>(null)
  const [alerts, setAlerts] = useState<UsageAlert[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    try {
      // Guard against missing IPC methods (may not be available in all builds)
      const api = window.electronAPI
      if (!api?.getSessionUsage || !api?.getWeeklyUsage) {
        setIsLoading(false)
        return
      }
      const [session, weekly] = await Promise.all([
        sessionId ? api.getSessionUsage(sessionId) : null,
        api.getWeeklyUsage(),
      ])
      if (session) setSessionUsage(session)
      if (weekly) setWeeklyUsage(weekly)
    } catch (err) {
      console.error('Failed to load usage data:', err)
    } finally {
      setIsLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Listen for real-time cost updates
  useEffect(() => {
    const api = window.electronAPI
    if (!api?.onUsageCostUpdate || !api?.onUsageAlert) return

    const cleanupCost = api.onUsageCostUpdate((data: SessionUsage) => {
      setSessionUsage(data)
    })
    const cleanupAlert = api.onUsageAlert((data: UsageAlert) => {
      setAlerts((prev) => [...prev, data])
    })
    return () => {
      cleanupCost()
      cleanupAlert()
    }
  }, [])

  const metrics: UsageMetrics = {
    session: {
      calls: sessionUsage?.totalCalls ?? 0,
      inputTokens: Object.values(sessionUsage?.providers ?? {}).reduce(
        (s, p) => s + p.inputTokens,
        0
      ),
      outputTokens: Object.values(sessionUsage?.providers ?? {}).reduce(
        (s, p) => s + p.outputTokens,
        0
      ),
      estimatedCostUsd: Object.values(sessionUsage?.providers ?? {}).reduce(
        (s, p) => s + p.estimatedCostUsd,
        0
      ),
      durationMs: sessionUsage?.totalDurationMs ?? 0,
    },
    weekly: {
      sessionCount: weeklyUsage?.sessionCount ?? 0,
      calls: weeklyUsage?.totals?.calls ?? 0,
      inputTokens: weeklyUsage?.totals?.inputTokens ?? 0,
      outputTokens: weeklyUsage?.totals?.outputTokens ?? 0,
      estimatedCostUsd: weeklyUsage?.totals?.estimatedCostUsd ?? 0,
    },
    teamCostUsd: sessionUsage?.teamUsage?.totalTeamCostUsd ?? null,
  }

  return { sessionUsage, weeklyUsage, metrics, alerts, isLoading, refresh }
}
