/**
 * ToolActivityIndicator
 *
 * Shows a compact live feed of a teammate's recent tool calls.
 * Used in the Command Center cards to provide real-time visibility
 * into what each worker is doing.
 */

import * as React from 'react'
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileSearch,
  Pencil,
  Terminal,
  Bot,
  Globe,
  MessageSquare,
  Wrench,
} from 'lucide-react'
import { cn } from '@/lib/utils'

// ============================================================
// Types
// ============================================================

export interface ToolActivity {
  toolName: string
  toolDisplayName?: string
  toolIntent?: string
  toolUseId: string
  status: 'executing' | 'completed' | 'error'
  inputPreview?: string
  resultPreview?: string
  isError?: boolean
  elapsedMs?: number
  timestamp: string
}

// ============================================================
// Tool Icon Mapping
// ============================================================

const TOOL_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  Read: FileSearch,
  Glob: FileSearch,
  Grep: FileSearch,
  Write: Pencil,
  Edit: Pencil,
  MultiEdit: Pencil,
  NotebookEdit: Pencil,
  Bash: Terminal,
  Task: Bot,
  TaskOutput: Bot,
  WebSearch: Globe,
  WebFetch: Globe,
  SendMessage: MessageSquare,
}

function getToolIcon(toolName: string): React.ComponentType<{ className?: string }> {
  return TOOL_ICON_MAP[toolName] ?? Wrench
}

/** Short display label for a tool */
function getToolLabel(activity: ToolActivity): string {
  if (activity.toolDisplayName) return activity.toolDisplayName
  // For common tools, show a brief description from the input preview
  if (activity.toolName === 'Read' && activity.inputPreview) {
    const match = activity.inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)
    if (match) {
      const parts = match[1].replace(/\\/g, '/').split('/')
      return parts[parts.length - 1] ?? activity.toolName
    }
  }
  if (activity.toolName === 'Bash' && activity.inputPreview) {
    const match = activity.inputPreview.match(/"command"\s*:\s*"([^"]{1,40})/)
    if (match) return match[1]
  }
  if (activity.toolName === 'Edit' && activity.inputPreview) {
    const match = activity.inputPreview.match(/"file_path"\s*:\s*"([^"]+)"/)
    if (match) {
      const parts = match[1].replace(/\\/g, '/').split('/')
      return parts[parts.length - 1] ?? activity.toolName
    }
  }
  return activity.toolName
}

// ============================================================
// Component
// ============================================================

export interface ToolActivityIndicatorProps {
  /** Recent tool activities for this teammate (newest first, max 5) */
  activities: ToolActivity[]
  className?: string
}

export function ToolActivityIndicator({ activities, className }: ToolActivityIndicatorProps) {
  if (activities.length === 0) {
    return (
      <div className={cn('text-xs text-muted-foreground py-1', className)}>
        No recent activity
      </div>
    )
  }

  return (
    <div className={cn('space-y-0.5', className)}>
      {activities.map((activity) => {
        const ToolIcon = getToolIcon(activity.toolName)
        const label = getToolLabel(activity)
        const isExecuting = activity.status === 'executing'
        const isError = activity.status === 'error'

        return (
          <div
            key={activity.toolUseId}
            className={cn(
              'flex items-center gap-1.5 text-[11px] leading-tight px-1.5 py-0.5 rounded',
              isExecuting && 'bg-blue-500/5',
              isError && 'bg-destructive/5',
            )}
          >
            {/* Status indicator */}
            {isExecuting ? (
              <Loader2 className="size-3 shrink-0 text-blue-500 animate-spin" />
            ) : isError ? (
              <AlertCircle className="size-3 shrink-0 text-destructive" />
            ) : (
              <CheckCircle2 className="size-3 shrink-0 text-muted-foreground/50" />
            )}

            {/* Tool icon */}
            <ToolIcon className={cn(
              'size-3 shrink-0',
              isExecuting ? 'text-blue-500' : 'text-muted-foreground/70',
            )} />

            {/* Tool name + label */}
            <span className={cn(
              'truncate',
              isExecuting ? 'text-foreground' : 'text-muted-foreground',
            )}>
              <span className="font-medium">{activity.toolName}</span>
              {label !== activity.toolName && (
                <span className="ml-1 opacity-70">{label}</span>
              )}
            </span>

            {/* Elapsed time for completed tools */}
            {activity.status === 'completed' && activity.elapsedMs != null && (
              <span className="ml-auto text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
                {activity.elapsedMs < 1000
                  ? `${activity.elapsedMs}ms`
                  : `${(activity.elapsedMs / 1000).toFixed(1)}s`}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
