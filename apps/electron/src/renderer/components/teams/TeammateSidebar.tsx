/**
 * TeammateSidebar
 *
 * Sidebar list of all teammates with status indicators.
 * Clicking a teammate selects them in the main panel.
 */

import * as React from 'react'
import { Bot, Loader2, Pause, AlertCircle, Clock, CheckCircle2 } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { AgentTeammate, AgentTeammateStatus } from '../../../shared/types'

export interface TeammateSidebarProps {
  teammates: AgentTeammate[]
  selectedTeammateId?: string
  onSelectTeammate: (id: string) => void
}

const STATUS_CONFIG: Record<AgentTeammateStatus, {
  icon: React.ComponentType<{ className?: string }>
  label: string
  className: string
  animate?: boolean
}> = {
  spawning: { icon: Loader2, label: 'Spawning', className: 'text-blue-500', animate: true },
  working: { icon: Loader2, label: 'Working', className: 'text-green-500', animate: true },
  idle: { icon: Pause, label: 'Idle', className: 'text-muted-foreground' },
  planning: { icon: Clock, label: 'Planning', className: 'text-purple-500' },
  'awaiting-approval': { icon: AlertCircle, label: 'Awaiting Approval', className: 'text-yellow-500' },
  error: { icon: AlertCircle, label: 'Error', className: 'text-destructive' },
  shutdown: { icon: CheckCircle2, label: 'Shutdown', className: 'text-muted-foreground' },
}

// Model display names
const MODEL_SHORT_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Opus',
  'claude-sonnet-4-5-20250929': 'Sonnet',
  'claude-haiku-4-5-20251001': 'Haiku',
  'kimi-k2.5': 'Kimi',
}

export function TeammateSidebar({
  teammates,
  selectedTeammateId,
  onSelectTeammate,
}: TeammateSidebarProps) {
  return (
    <div className="w-56 border-r border-border bg-background/50 flex flex-col h-full">
      <div className="px-3 py-2 border-b border-border">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Teammates
        </h3>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-1.5 space-y-0.5">
          {teammates.map((teammate) => {
            const config = STATUS_CONFIG[teammate.status] || STATUS_CONFIG.idle
            const StatusIcon = config.icon
            const isSelected = teammate.id === selectedTeammateId
            const modelName = MODEL_SHORT_NAMES[teammate.model] || teammate.model

            return (
              <button
                key={teammate.id}
                type="button"
                onClick={() => onSelectTeammate(teammate.id)}
                className={cn(
                  'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors',
                  isSelected
                    ? 'bg-foreground/5'
                    : 'hover:bg-foreground/[0.03]'
                )}
              >
                {/* Status indicator */}
                <div className="mt-0.5 shrink-0">
                  <StatusIcon
                    className={cn(
                      'size-3.5',
                      config.className,
                      config.animate && 'animate-spin'
                    )}
                  />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{teammate.name}</span>
                    {teammate.isLead && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                        Lead
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] text-muted-foreground truncate">
                      {teammate.currentTask || config.label}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <Badge variant="outline" className="text-[10px] px-1 py-0 h-4 border-border">
                      {modelName}
                    </Badge>
                    {teammate.tokenUsage && (
                      <span className="text-[10px] text-muted-foreground">
                        ${teammate.tokenUsage.costUsd.toFixed(2)}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}
