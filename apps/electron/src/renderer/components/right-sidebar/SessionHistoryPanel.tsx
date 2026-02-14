import * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { Message } from '@craft-agent/core/types'
import { PanelHeader } from '../app-shell/PanelHeader'

export interface SessionHistoryPanelProps {
  sessionId?: string
  closeButton?: React.ReactNode
}

function roleLabel(message: Message): string {
  if (message.role === 'tool') {
    return message.toolDisplayName || message.toolName || 'Tool'
  }
  if (message.role === 'user') return 'You'
  if (message.role === 'assistant') return 'Craft Agent'
  return message.role
}

function previewText(message: Message): string {
  const raw = message.toolResult || message.content || ''
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return '(empty)'
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized
}

function formatTime(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return ''
  }
}

/**
 * Implements REQ-001: Provide a usable session history view in the right sidebar.
 */
export function SessionHistoryPanel({ sessionId, closeButton }: SessionHistoryPanelProps) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let mounted = true

    async function load() {
      if (!sessionId) {
        setMessages([])
        return
      }
      setLoading(true)
      try {
        const session = await window.electronAPI.getSessionMessages(sessionId)
        if (!mounted) return
        setMessages(session?.messages ?? [])
      } catch {
        if (!mounted) return
        setMessages([])
      } finally {
        if (mounted) setLoading(false)
      }
    }

    void load()
    return () => { mounted = false }
  }, [sessionId])

  const displayMessages = useMemo(() => {
    return [...messages].slice(-200).reverse()
  }, [messages])

  return (
    <div className="h-full min-h-0 flex flex-col">
      <PanelHeader title="History" actions={closeButton} />
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        {!sessionId ? (
          <p className="text-xs text-muted-foreground">No session selected.</p>
        ) : loading ? (
          <p className="text-xs text-muted-foreground">Loading history…</p>
        ) : displayMessages.length === 0 ? (
          <p className="text-xs text-muted-foreground">No messages yet.</p>
        ) : (
          <div className="space-y-2">
            {displayMessages.map((message) => (
              <div key={message.id} className="rounded-md border border-foreground/10 p-2 bg-background/30">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-foreground/80">{roleLabel(message)}</span>
                  <span className="text-[10px] text-muted-foreground">{formatTime(message.timestamp)}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground break-words">{previewText(message)}</p>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

