/**
 * QualityGateReport
 *
 * Expandable component that displays the results of an automated quality gate review.
 * Shows:
 * - Overall pass/fail status with aggregate score
 * - Per-stage score breakdown with progress bars
 * - Issue list with suggestions
 * - Cycle history (what failed, what was fixed)
 */

import * as React from 'react'
import { useState } from 'react'
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, AlertTriangle, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { QualityGateResult, QualityGateStageResult, QualityGateStageName } from '../../../shared/types'

// ============================================================
// Stage Display Config
// ============================================================

const STAGE_META: Record<QualityGateStageName, { label: string; binary?: boolean }> = {
  syntax: { label: 'Syntax & Types', binary: true },
  tests: { label: 'Test Execution', binary: true },
  architecture: { label: 'Architecture Review' },
  simplicity: { label: 'Simplicity Review' },
  errors: { label: 'Error Analysis' },
  completeness: { label: 'Completeness Check' },
}

function scoreColor(score: number): string {
  if (score >= 90) return 'text-green-500'
  if (score >= 75) return 'text-yellow-500'
  return 'text-red-500'
}

function scoreBgColor(score: number): string {
  if (score >= 90) return 'bg-green-500'
  if (score >= 75) return 'bg-yellow-500'
  return 'bg-red-500'
}

// ============================================================
// Sub-components
// ============================================================

function StageRow({ name, result }: { name: QualityGateStageName; result: QualityGateStageResult }) {
  const [expanded, setExpanded] = useState(false)
  const meta = STAGE_META[name]
  const hasDetails = result.issues.length > 0 || result.suggestions.length > 0

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded(!expanded)}
        className={cn(
          'w-full flex items-center gap-3 px-3 py-2 text-left',
          hasDetails ? 'hover:bg-foreground/[0.02] cursor-pointer' : 'cursor-default'
        )}
      >
        {/* Status icon */}
        {result.passed ? (
          <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />
        ) : (
          <XCircle className="size-3.5 text-red-500 shrink-0" />
        )}

        {/* Stage name */}
        <span className="text-xs font-medium flex-1">{meta.label}</span>

        {/* Score */}
        {meta.binary ? (
          <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4', result.passed ? 'border-green-500/30 text-green-500' : 'border-red-500/30 text-red-500')}>
            {result.passed ? 'PASS' : 'FAIL'}
          </Badge>
        ) : (
          <div className="flex items-center gap-2">
            <div className="w-16 h-1.5 bg-foreground/10 rounded-full overflow-hidden">
              <div className={cn('h-full rounded-full transition-all', scoreBgColor(result.score))} style={{ width: `${result.score}%` }} />
            </div>
            <span className={cn('text-[10px] font-mono tabular-nums', scoreColor(result.score))}>{result.score}</span>
          </div>
        )}

        {/* Expand arrow */}
        {hasDetails && (
          expanded ? <ChevronDown className="size-3 text-muted-foreground" /> : <ChevronRight className="size-3 text-muted-foreground" />
        )}
      </button>

      {/* Expanded details */}
      {expanded && hasDetails && (
        <div className="px-3 pb-2 pl-9 space-y-1.5">
          {result.issues.length > 0 && (
            <div>
              <span className="text-[10px] text-red-400 font-medium">Issues:</span>
              <ul className="mt-0.5 space-y-0.5">
                {result.issues.map((issue, i) => (
                  <li key={i} className="text-[11px] text-foreground/70 pl-2 border-l border-red-500/20">{issue}</li>
                ))}
              </ul>
            </div>
          )}
          {result.suggestions.length > 0 && (
            <div>
              <span className="text-[10px] text-blue-400 font-medium">Suggestions:</span>
              <ul className="mt-0.5 space-y-0.5">
                {result.suggestions.map((s, i) => (
                  <li key={i} className="text-[11px] text-foreground/70 pl-2 border-l border-blue-500/20">{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Main Component
// ============================================================

export interface QualityGateReportProps {
  /** The quality gate result to display */
  result: QualityGateResult
  /** Optional cycle history for showing improvement over time */
  cycleHistory?: QualityGateResult[]
  /** Whether initially expanded */
  defaultExpanded?: boolean
  /** Additional className */
  className?: string
}

export function QualityGateReport({
  result,
  cycleHistory,
  defaultExpanded = false,
  className,
}: QualityGateReportProps) {
  const [expanded, setExpanded] = useState(defaultExpanded)

  const statusColor = result.passed ? 'border-green-500/20 bg-green-500/5' : 'border-red-500/20 bg-red-500/5'
  const statusText = result.passed ? 'PASSED' : 'FAILED'
  const statusBadge = result.passed
    ? 'border-green-500/30 text-green-500'
    : 'border-red-500/30 text-red-500'

  return (
    <div className={cn('rounded-lg border', statusColor, className)}>
      {/* Summary header (always visible) */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-foreground/[0.02]"
      >
        {result.passed ? (
          <CheckCircle2 className="size-4 text-green-500 shrink-0" />
        ) : (
          <XCircle className="size-4 text-red-500 shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Quality Gate</span>
            <Badge variant="outline" className={cn('text-[10px] px-1.5 py-0 h-4', statusBadge)}>
              {statusText}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Score: {result.aggregateScore}/100
            {result.cycleCount > 1 && ` \u00b7 Cycle ${result.cycleCount}/${result.maxCycles}`}
            {result.escalatedTo && ' \u00b7 Escalated'}
          </p>
        </div>

        {/* Score bar */}
        <div className="flex items-center gap-2">
          <div className="w-20 h-2 bg-foreground/10 rounded-full overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all', scoreBgColor(result.aggregateScore))}
              style={{ width: `${result.aggregateScore}%` }}
            />
          </div>
          <span className={cn('text-xs font-mono tabular-nums', scoreColor(result.aggregateScore))}>
            {result.aggregateScore}
          </span>
        </div>

        {expanded ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
      </button>

      {/* Expanded: per-stage breakdown */}
      {expanded && (
        <div className="border-t border-border/50">
          {/* Stage list */}
          {(Object.entries(result.stages) as [QualityGateStageName, QualityGateStageResult][]).map(([name, stageResult]) => (
            <StageRow key={name} name={name} result={stageResult} />
          ))}

          {/* Cycle history */}
          {cycleHistory && cycleHistory.length > 1 && (
            <div className="px-3 py-2 border-t border-border/50">
              <div className="flex items-center gap-1.5 mb-1.5">
                <RefreshCw className="size-3 text-muted-foreground" />
                <span className="text-[10px] text-muted-foreground font-medium">Review History</span>
              </div>
              <div className="flex items-center gap-1">
                {cycleHistory.map((cycle, i) => (
                  <div
                    key={i}
                    className={cn(
                      'flex items-center justify-center size-6 rounded text-[10px] font-mono',
                      cycle.passed
                        ? 'bg-green-500/10 text-green-500'
                        : 'bg-red-500/10 text-red-500'
                    )}
                    title={`Cycle ${i + 1}: ${cycle.aggregateScore}/100`}
                  >
                    {cycle.aggregateScore}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Escalation note */}
          {result.escalatedTo && (
            <div className="px-3 py-2 border-t border-border/50">
              <div className="flex items-center gap-1.5">
                <AlertTriangle className="size-3 text-yellow-500" />
                <span className="text-[10px] text-yellow-500">
                  Escalated to {result.escalatedTo} after {result.cycleCount} review cycles
                </span>
              </div>
            </div>
          )}

          {/* Model info */}
          <div className="px-3 py-1.5 border-t border-border/50 flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              Reviewed by {result.reviewModel} ({result.reviewProvider})
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
