/**
 * TeammateDetailView
 *
 * Main panel showing the selected teammate's streaming output,
 * current task, model badge, and message input.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { Send, MoreHorizontal, ArrowUpCircle, Power, RefreshCw, Activity, MessageSquare, ArrowDown } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useScrollAnchor } from '@/hooks/useScrollAnchor'
import type { AgentTeammate, TeammateMessage } from '../../../shared/types'
import type { ToolActivity } from './ToolActivityIndicator'
import { WorkerActivityStream } from './WorkerActivityStream'

export interface TeammateDetailViewProps {
  teammate: AgentTeammate
  messages: TeammateMessage[]
  /** Recent tool activities for this teammate (for Activity view) */
  toolActivities?: ToolActivity[]
  onSendMessage: (teammateId: string, content: string) => void
  onSwapModel?: (teammateId: string) => void
  onShutdown?: (teammateId: string) => void
  onEscalate?: (teammateId: string) => void
}

// Model display names
const MODEL_NAMES: Record<string, string> = {
  'claude-opus-4-6': 'Opus 4.6',
  'claude-sonnet-4-5-20250929': 'Sonnet 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'kimi-k2.5': 'Kimi K2.5',
}

export function TeammateDetailView({
  teammate,
  messages,
  toolActivities = [],
  onSendMessage,
  onSwapModel,
  onShutdown,
  onEscalate,
}: TeammateDetailViewProps) {
  const [inputValue, setInputValue] = useState('')
  const [detailTab, setDetailTab] = useState<'messages' | 'activity'>(
    toolActivities.length > 0 ? 'activity' : 'messages'
  )
  const modelName = MODEL_NAMES[teammate.model] || teammate.model

  const handleSend = useCallback(() => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    onSendMessage(teammate.id, trimmed)
    setInputValue('')
  }, [inputValue, teammate.id, onSendMessage])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend]
  )

  // Filter messages relevant to this teammate
  const relevantMessages = messages.filter(
    m => m.from === teammate.id || m.to === teammate.id || m.to === 'all'
  )

  // Implements REQ-001: direction-aware scroll anchor prevents snap-back
  const { viewportRef, endRef, isScrolledUp, scrollToBottom } = useScrollAnchor({
    contentLength: relevantMessages.length,
    resetKey: teammate.id,
  })

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Teammate header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-3 min-w-0">
          {/* Implements REQ-002: Show teammate name and role */}
          <div className="flex flex-col min-w-0">
            <h3 className="text-sm font-semibold truncate leading-tight">{teammate.name}</h3>
            <span className="text-[11px] text-muted-foreground capitalize leading-tight">
              {teammate.role} • {modelName}
            </span>
          </div>
          {teammate.currentTask && (
            <span className="text-xs text-muted-foreground truncate max-w-48">
              {teammate.currentTask}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {/* Token usage */}
          {teammate.tokenUsage && (
            <span className="text-xs text-muted-foreground mr-2">
              {(teammate.tokenUsage.inputTokens / 1000).toFixed(0)}K in /
              {(teammate.tokenUsage.outputTokens / 1000).toFixed(0)}K out
              (${teammate.tokenUsage.costUsd.toFixed(2)})
            </span>
          )}

          {/* Actions */}
          {onSwapModel && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onSwapModel(teammate.id)}
              className="size-7"
              title="Swap model"
              aria-label="Swap model"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
          {onEscalate && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onEscalate(teammate.id)}
              className="size-7"
              title="Escalate to higher-tier model"
              aria-label="Escalate model"
            >
              <ArrowUpCircle className="size-3.5" />
            </Button>
          )}
          {onShutdown && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onShutdown(teammate.id)}
              className="size-7 text-muted-foreground hover:text-destructive"
              title="Shutdown teammate"
              aria-label="Shutdown teammate"
            >
              <Power className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* View toggle: Messages / Activity */}
      {toolActivities.length > 0 && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border">
          <button
            type="button"
            onClick={() => setDetailTab('activity')}
            className={cn(
              'px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
              detailTab === 'activity'
                ? 'bg-foreground/5 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
            )}
          >
            <Activity className="size-3" />
            Activity
            {toolActivities.filter(a => a.status === 'executing').length > 0 && (
              <span className="size-1.5 rounded-full bg-blue-500 animate-pulse" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setDetailTab('messages')}
            className={cn(
              'px-2.5 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5',
              detailTab === 'messages'
                ? 'bg-foreground/5 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.03]'
            )}
          >
            <MessageSquare className="size-3" />
            Messages
            {relevantMessages.length > 0 && (
              <span className="text-[10px] bg-foreground/10 rounded-full px-1.5">
                {relevantMessages.length}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Content area: Messages or Activity */}
      {detailTab === 'activity' && toolActivities.length > 0 ? (
        <WorkerActivityStream
          teammateId={teammate.id}
          teammateName={teammate.name}
          messages={messages}
          toolActivities={toolActivities}
          className="flex-1 min-h-0"
        />
      ) : (
        <div className="relative flex-1 min-h-0">
          <ScrollArea className="h-full" viewportRef={viewportRef}>
            <div className="p-4 space-y-3">
              {relevantMessages.length === 0 ? (
                <div className="flex items-center justify-center h-32 text-muted-foreground">
                  <p className="text-sm">
                    {teammate.status === 'spawning'
                      ? 'Spawning teammate...'
                      : teammate.status === 'idle'
                        ? 'Waiting for task assignment'
                        : 'No messages yet'}
                  </p>
                </div>
              ) : (
                relevantMessages.map((msg) => {
                  const isFromTeammate = msg.from === teammate.id
                  return (
                    <div key={msg.id} className={cn('flex', isFromTeammate ? 'justify-start' : 'justify-end')}>
                      <div className={cn(
                        'max-w-[85%] rounded-lg px-3 py-2 text-sm',
                        isFromTeammate
                          ? 'bg-background shadow-minimal'
                          : 'bg-foreground text-background'
                      )}>
                        <div className={cn('flex items-center gap-2 mb-1', !isFromTeammate && 'text-background/70')}>
                          <span className="text-xs font-medium">
                            {isFromTeammate ? teammate.name : msg.from === 'user' ? 'You' : msg.from}
                          </span>
                          <span className={cn('text-[10px]', isFromTeammate ? 'text-muted-foreground' : 'text-background/50')}>
                            {new Date(msg.timestamp).toLocaleTimeString()}
                          </span>
                          {msg.type !== 'message' && (
                            <Badge variant="secondary" className={cn(
                              'text-[10px] px-1 py-0 h-4',
                              !isFromTeammate && 'bg-background/20 text-background border-transparent'
                            )}>
                              {msg.type}
                            </Badge>
                          )}
                        </div>
                        <p className={cn('whitespace-pre-wrap', isFromTeammate ? 'text-foreground/80' : 'text-background/90')}>{msg.content}</p>
                      </div>
                    </div>
                  )
                })
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          {/* Jump-to-bottom indicator */}
          {isScrolledUp && (
            <button
              type="button"
              onClick={scrollToBottom}
              className="absolute bottom-3 right-3 z-10 flex items-center gap-1.5 rounded-full
                         bg-foreground/10 hover:bg-foreground/20 backdrop-blur-sm
                         px-3 py-1.5 text-xs text-foreground/80 shadow-md transition-all"
            >
              <ArrowDown className="size-3" />
              New messages
            </button>
          )}
        </div>
      )}

      {/* Message input */}
      <div className="border-t border-border p-3">
        <div className="flex items-center gap-2">
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${teammate.name}...`}
            aria-label={`Message ${teammate.name}`}
            className="flex-1"
          />
          <Button
            size="icon"
            onClick={handleSend}
            disabled={!inputValue.trim()}
            className="shrink-0 size-8"
            aria-label="Send message"
          >
            <Send className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
