/**
 * ReviewGateCard
 *
 * Inline card shown when a teammate submits work for review.
 * Provides approve/reject with feedback buttons.
 * When rejected, teammate revises and resubmits.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { ThumbsUp, ThumbsDown, ArrowUpCircle, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ReviewResult, ReviewPolicy } from '../../../shared/types'

export interface ReviewGateCardProps {
  /** Teammate name who submitted */
  teammateName: string
  /** Task title */
  taskTitle: string
  /** Summary of what was done */
  summary: string
  /** Files changed */
  filesChanged?: string[]
  /** Review policy */
  policy: ReviewPolicy
  /** Called with the review result */
  onReview: (result: ReviewResult) => void
  /** Additional className */
  className?: string
}

export function ReviewGateCard({
  teammateName,
  taskTitle,
  summary,
  filesChanged,
  policy,
  onReview,
  className,
}: ReviewGateCardProps) {
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedback, setFeedback] = useState('')

  // Hooks must be called unconditionally
  const handleApprove = useCallback(() => {
    onReview({ approved: true })
  }, [onReview])

  const handleReject = useCallback(() => {
    if (feedbackMode && feedback.trim()) {
      onReview({ approved: false, feedback: feedback.trim() })
    } else {
      setFeedbackMode(true)
    }
  }, [feedbackMode, feedback, onReview])

  const handleEscalate = useCallback(() => {
    onReview({ approved: false, escalate: true, feedback: feedback.trim() || 'Escalating to higher-tier model' })
  }, [feedback, onReview])

  // Auto-approve for 'trust' policy - must come after all hooks
  React.useEffect(() => {
    if (policy === 'trust') {
      onReview({ approved: true })
    }
  }, [policy, onReview])

  // If policy is 'trust', don't render the UI
  if (policy === 'trust') {
    return null
  }

  return (
    <div
      className={cn(
        'rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4 space-y-3',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{teammateName}</span>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 border-yellow-500/30 text-yellow-600">
              Needs Review
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">{taskTitle}</p>
        </div>
      </div>

      {/* Summary */}
      <div className="rounded-md bg-background/50 px-3 py-2">
        <p className="text-sm text-foreground/80 whitespace-pre-wrap">{summary}</p>
      </div>

      {/* Files changed */}
      {filesChanged && filesChanged.length > 0 && (
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Files changed:</span>
          <div className="flex flex-wrap gap-1">
            {filesChanged.map((file) => (
              <Badge key={file} variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-mono">
                {file}
              </Badge>
            ))}
          </div>
        </div>
      )}

      {/* Feedback input */}
      {feedbackMode && (
        <div className="space-y-2">
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Provide feedback for revision..."
            className={cn(
              'w-full rounded-md bg-background border border-border px-3 py-2 text-sm',
              'focus:outline-none focus:ring-1 focus:ring-foreground/20',
              'placeholder:text-muted-foreground/50 resize-none'
            )}
            rows={3}
          />
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleApprove} className="h-7 gap-1 text-xs">
          <ThumbsUp className="size-3" />
          Approve
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleReject}
          className="h-7 gap-1 text-xs"
        >
          {feedbackMode ? (
            <>
              <MessageSquare className="size-3" />
              Send Feedback
            </>
          ) : (
            <>
              <ThumbsDown className="size-3" />
              Reject
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEscalate}
          className="h-7 gap-1 text-xs text-yellow-600 hover:text-yellow-700"
        >
          <ArrowUpCircle className="size-3" />
          Escalate
        </Button>
      </div>
    </div>
  )
}
