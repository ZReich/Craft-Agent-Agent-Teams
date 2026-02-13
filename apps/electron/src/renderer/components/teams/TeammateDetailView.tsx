/**
 * TeammateDetailView
 *
 * Main panel showing the selected teammate's streaming output,
 * current task, model badge, and message input.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { Send, MoreHorizontal, ArrowUpCircle, Power, RefreshCw } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AgentTeammate, TeammateMessage } from '../../../shared/types'

export interface TeammateDetailViewProps {
  teammate: AgentTeammate
  messages: TeammateMessage[]
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
  onSendMessage,
  onSwapModel,
  onShutdown,
  onEscalate,
}: TeammateDetailViewProps) {
  const [inputValue, setInputValue] = useState('')
  // Implements REQ-003, REQ-004: auto-scroll when at bottom
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const endRef = React.useRef<HTMLDivElement>(null)
  const isStickToBottomRef = React.useRef(true)
  const skipSmoothUntilRef = React.useRef(0)
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

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior) => {
    endRef.current?.scrollIntoView({ behavior, block: 'end' })
  }, [])

  // Scroll to bottom on teammate switch (instant to avoid visible jump)
  React.useLayoutEffect(() => {
    scrollToBottom('instant')
    isStickToBottomRef.current = true
    skipSmoothUntilRef.current = Date.now() + 400
  }, [teammate.id, scrollToBottom])

  // Track scroll position to toggle sticky behavior
  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight
      isStickToBottomRef.current = distanceFromBottom < 20
    }
    viewport.addEventListener('scroll', handleScroll)
    return () => viewport.removeEventListener('scroll', handleScroll)
  }, [])

  // Auto-scroll on new messages only when user is at bottom
  React.useEffect(() => {
    if (!isStickToBottomRef.current) return
    if (Date.now() < skipSmoothUntilRef.current) return
    scrollToBottom('smooth')
  }, [relevantMessages.length, scrollToBottom])

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Teammate header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold truncate">{teammate.name}</h3>
          <Badge variant="outline" className="text-[11px] px-1.5 py-0">
            {modelName}
          </Badge>
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

      {/* Message/output area */}
      <ScrollArea className="flex-1 min-h-0" viewportRef={viewportRef}>
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
