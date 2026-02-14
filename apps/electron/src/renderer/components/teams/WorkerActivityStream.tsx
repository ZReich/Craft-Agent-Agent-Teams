/**
 * WorkerActivityStream
 *
 * Full interleaved stream of a teammate's messages and tool calls.
 * Used in the Focus View (TeammateDetailView) to provide comprehensive
 * visibility into what a worker is doing.
 */

import * as React from 'react'
import { useState, useMemo } from 'react'
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
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { TeammateMessage } from '../../../shared/types'
import type { ToolActivity } from './ToolActivityIndicator'

// ============================================================
// Types
// ============================================================

interface StreamEntry {
  kind: 'message' | 'tool'
  timestamp: string
  message?: TeammateMessage
  tool?: ToolActivity
}

export interface WorkerActivityStreamProps {
  teammateId: string
  teammateName: string
  messages: TeammateMessage[]
  toolActivities: ToolActivity[]
  className?: string
}

// ============================================================
// Tool Icon Mapping (shared with ToolActivityIndicator)
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

// ============================================================
// Sub-components
// ============================================================

function ToolActivityEntry({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false)
  const ToolIcon = getToolIcon(activity.toolName)
  const isExecuting = activity.status === 'executing'
  const isError = activity.status === 'error'
  const hasDetails = activity.inputPreview || activity.resultPreview || activity.toolIntent

  return (
    <div className={cn(
      'rounded-md px-3 py-2 text-xs',
      isExecuting && 'bg-blue-500/5',
      isError && 'bg-destructive/5',
      !isExecuting && !isError && 'bg-foreground/[0.02]',
    )}>
      <div className="flex items-center gap-2">
        {/* Status icon */}
        {isExecuting ? (
          <Loader2 className="size-3.5 shrink-0 text-blue-500 animate-spin" />
        ) : isError ? (
          <AlertCircle className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-3.5 shrink-0 text-muted-foreground/50" />
        )}

        {/* Tool icon */}
        <ToolIcon className={cn(
          'size-3.5 shrink-0',
          isExecuting ? 'text-blue-500' : 'text-muted-foreground/70',
        )} />

        {/* Tool name + intent */}
        <span className={cn(
          'flex-1 truncate',
          isExecuting ? 'text-foreground' : 'text-muted-foreground',
        )}>
          <span className="font-medium">{activity.toolName}</span>
          {activity.toolDisplayName && activity.toolDisplayName !== activity.toolName && (
            <span className="ml-1.5 opacity-70">{activity.toolDisplayName}</span>
          )}
        </span>

        {/* Elapsed time */}
        {activity.status === 'completed' && activity.elapsedMs != null && (
          <span className="text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
            {activity.elapsedMs < 1000
              ? `${activity.elapsedMs}ms`
              : `${(activity.elapsedMs / 1000).toFixed(1)}s`}
          </span>
        )}

        {/* Expand/collapse toggle */}
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded(prev => !prev)}
            className="shrink-0 p-0.5 rounded hover:bg-foreground/5 text-muted-foreground"
          >
            {expanded
              ? <ChevronDown className="size-3" />
              : <ChevronRight className="size-3" />}
          </button>
        )}
      </div>

      {/* Intent line */}
      {activity.toolIntent && (
        <p className="mt-1 text-[11px] text-muted-foreground/60 pl-[26px] leading-snug">
          {activity.toolIntent}
        </p>
      )}

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="mt-2 pl-[26px] space-y-1.5">
          {activity.inputPreview && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-0.5">Input</p>
              <pre className="text-[11px] text-muted-foreground bg-foreground/[0.03] rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed">
                {activity.inputPreview}
              </pre>
            </div>
          )}
          {activity.resultPreview && (
            <div>
              <p className="text-[10px] font-medium text-muted-foreground/50 uppercase tracking-wider mb-0.5">Result</p>
              <pre className={cn(
                'text-[11px] rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed',
                isError ? 'text-destructive bg-destructive/5' : 'text-muted-foreground bg-foreground/[0.03]',
              )}>
                {activity.resultPreview}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MessageEntry({ message, teammateName }: { message: TeammateMessage; teammateName: string }) {
  const isFromTeammate = message.from !== 'user'

  return (
    <div className={cn('flex', isFromTeammate ? 'justify-start' : 'justify-end')}>
      <div className={cn(
        'max-w-[85%] rounded-lg px-3 py-2 text-sm',
        isFromTeammate
          ? 'bg-background shadow-minimal'
          : 'bg-foreground text-background'
      )}>
        <div className={cn('flex items-center gap-2 mb-1', !isFromTeammate && 'text-background/70')}>
          <MessageSquare className={cn('size-3', isFromTeammate ? 'text-muted-foreground' : 'text-background/50')} />
          <span className="text-xs font-medium">
            {isFromTeammate ? teammateName : message.from === 'user' ? 'You' : message.from}
          </span>
          <span className={cn('text-[10px]', isFromTeammate ? 'text-muted-foreground' : 'text-background/50')}>
            {new Date(message.timestamp).toLocaleTimeString()}
          </span>
        </div>
        <p className={cn('whitespace-pre-wrap', isFromTeammate ? 'text-foreground/80' : 'text-background/90')}>
          {message.content}
        </p>
      </div>
    </div>
  )
}

// ============================================================
// Main Component
// ============================================================

export function WorkerActivityStream({
  teammateId,
  teammateName,
  messages,
  toolActivities,
  className,
}: WorkerActivityStreamProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const endRef = React.useRef<HTMLDivElement>(null)
  const isStickToBottomRef = React.useRef(true)

  // Interleave messages and tool activities by timestamp
  const entries: StreamEntry[] = useMemo(() => {
    const items: StreamEntry[] = []

    // Add messages relevant to this teammate
    messages
      .filter(m => m.from === teammateId || m.to === teammateId || m.to === 'all')
      .forEach(msg => {
        items.push({ kind: 'message', timestamp: msg.timestamp, message: msg })
      })

    // Add tool activities
    toolActivities.forEach(tool => {
      items.push({ kind: 'tool', timestamp: tool.timestamp, tool })
    })

    // Sort by timestamp (oldest first)
    items.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

    return items
  }, [teammateId, messages, toolActivities])

  // Track scroll position for sticky behavior
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      isStickToBottomRef.current = (scrollHeight - scrollTop - clientHeight) < 20
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll on new entries when at bottom
  React.useEffect(() => {
    if (!isStickToBottomRef.current) return
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [entries.length])

  if (entries.length === 0) {
    return (
      <div className={cn('flex items-center justify-center h-full text-muted-foreground', className)}>
        <p className="text-sm">No activity yet</p>
      </div>
    )
  }

  return (
    <ScrollArea className={cn('flex-1 min-h-0', className)} viewportRef={viewportRef}>
      <div className="p-4 space-y-2">
        {entries.map((entry, idx) => {
          if (entry.kind === 'message' && entry.message) {
            return (
              <MessageEntry
                key={`msg-${entry.message.id}`}
                message={entry.message}
                teammateName={teammateName}
              />
            )
          }
          if (entry.kind === 'tool' && entry.tool) {
            return (
              <ToolActivityEntry
                key={`tool-${entry.tool.toolUseId}`}
                activity={entry.tool}
              />
            )
          }
          return null
        })}
        <div ref={endRef} />
      </div>
    </ScrollArea>
  )
}
