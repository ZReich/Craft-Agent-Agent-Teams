import * as React from 'react'
import { AlertTriangle, RotateCw, OctagonX } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { TeamActivityEvent } from '../../../shared/types'

export interface HealthAlertsCardProps {
  events: TeamActivityEvent[]
  className?: string
  onOpenActivity?: () => void
}

function isErrorLoop(details: string): boolean {
  const normalized = details.toLowerCase()
  return normalized.includes('error loop') || normalized.includes('error-loop')
}

function isRetryStorm(details: string): boolean {
  const normalized = details.toLowerCase()
  return normalized.includes('retry storm') || normalized.includes('retry-storm')
}

function isStall(details: string): boolean {
  const normalized = details.toLowerCase()
  return normalized.includes('stall') && !isErrorLoop(normalized) && !isRetryStorm(normalized)
}

export function HealthAlertsCard({ events, className, onOpenActivity }: HealthAlertsCardProps) {
  const healthAlerts = React.useMemo(() => events.filter((event) => {
    if (isStall(event.details)) return true
    if (isErrorLoop(event.details)) return true
    if (isRetryStorm(event.details)) return true
    return false
  }), [events])

  const stallCount = React.useMemo(
    () => healthAlerts.filter((event) => isStall(event.details)).length,
    [healthAlerts]
  )
  const errorLoopCount = React.useMemo(
    () => healthAlerts.filter((event) => isErrorLoop(event.details)).length,
    [healthAlerts]
  )
  const retryStormCount = React.useMemo(
    () => healthAlerts.filter((event) => isRetryStorm(event.details)).length,
    [healthAlerts]
  )

  const latestAlerts = healthAlerts.slice(-3).reverse()

  return (
    <div className={cn('rounded-lg border border-border bg-background p-3 shadow-tinted', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <AlertTriangle className="size-4 text-warning-text" />
          <h3 className="text-sm font-semibold">Health Alerts</h3>
          <Badge variant={healthAlerts.length > 0 ? 'destructive' : 'secondary'} className="text-[10px] px-2 py-0.5">
            {healthAlerts.length}
          </Badge>
        </div>
        {onOpenActivity && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onOpenActivity}>
            Open Activity
          </Button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
        <Badge variant="outline" className="gap-1.5">
          <AlertTriangle className="size-3 text-warning-text" />
          Stall: {stallCount}
        </Badge>
        <Badge variant="outline" className="gap-1.5">
          <OctagonX className="size-3 text-destructive" />
          Error loop: {errorLoopCount}
        </Badge>
        <Badge variant="outline" className="gap-1.5">
          <RotateCw className="size-3 text-orange-500" />
          Retry storm: {retryStormCount}
        </Badge>
      </div>

      <div className="mt-3 space-y-1.5">
        {latestAlerts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No active health alerts.</p>
        ) : (
          latestAlerts.map((event) => (
            <div key={event.id} className="rounded-md bg-foreground/[0.03] px-2 py-1.5">
              <p className="text-xs text-foreground/90 whitespace-pre-wrap break-words">{event.details}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {event.teammateName ?? 'Team'} • {new Date(event.timestamp).toLocaleTimeString()}
              </p>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

