/**
 * ExportPanel
 *
 * Dropdown button with export options for SDD data:
 * spec summary, coverage report, gate results, and full JSON bundle.
 */

import * as React from 'react'
import { useState, useRef, useEffect } from 'react'
import { Download, FileText, Code, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  exportSpecSummary,
  exportCoverageReport,
  exportGateResults,
  exportSDDBundle,
} from '@craft-agent/shared/agent-teams/sdd-exports'
import type { SpecComplianceReport, QualityGateResult } from '../../../shared/types'
import type { Spec, TraceabilityEntry } from '@craft-agent/core/types'

export interface ExportPanelProps {
  onExport: (content: string, filename: string, format: 'md' | 'json') => void
  spec?: Spec
  coverageReport?: SpecComplianceReport
  gateResults?: QualityGateResult
  traceabilityMap?: TraceabilityEntry[]
  className?: string
}

interface ExportOption {
  label: string
  filename: string
  format: 'md' | 'json'
  icon: typeof FileText
  disabled: boolean
  generate: () => string
}

export function ExportPanel({
  onExport,
  spec,
  coverageReport,
  gateResults,
  traceabilityMap,
  className,
}: ExportPanelProps) {
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [isOpen])

  const options: ExportOption[] = [
    {
      label: 'Spec Summary (.md)',
      filename: spec ? `spec-${spec.specId}.md` : 'spec-summary.md',
      format: 'md',
      icon: FileText,
      disabled: !spec,
      generate: () => spec ? exportSpecSummary(spec) : '',
    },
    {
      label: 'Coverage Report (.md)',
      filename: 'coverage-report.md',
      format: 'md',
      icon: FileText,
      disabled: !coverageReport,
      generate: () => coverageReport ? exportCoverageReport(coverageReport) : '',
    },
    {
      label: 'Gate Results (.md)',
      filename: 'gate-results.md',
      format: 'md',
      icon: FileText,
      disabled: !gateResults,
      generate: () => gateResults ? exportGateResults(gateResults, spec?.specId) : '',
    },
    {
      label: 'Full Bundle (.json)',
      filename: spec ? `sdd-bundle-${spec.specId}.json` : 'sdd-bundle.json',
      format: 'json',
      icon: Code,
      disabled: !spec,
      generate: () => spec ? exportSDDBundle({
        spec,
        complianceReport: coverageReport,
        gateResults: gateResults ? [gateResults] : undefined,
        traceabilityMap,
      }) : '',
    },
  ]

  return (
    <div ref={ref} className={cn('relative', className)}>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(prev => !prev)}
        className="gap-1.5 text-xs"
      >
        <Download className="size-3" />
        Export
        <ChevronDown className={cn('size-3 transition-transform', isOpen && 'rotate-180')} />
      </Button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-border bg-background shadow-md py-1">
          {options.map((option) => {
            const Icon = option.icon
            return (
              <button
                key={option.label}
                type="button"
                disabled={option.disabled}
                onClick={() => {
                  onExport(option.generate(), option.filename, option.format)
                  setIsOpen(false)
                }}
                className={cn(
                  'flex items-center gap-2 w-full px-3 py-1.5 text-xs text-left transition-colors',
                  option.disabled
                    ? 'text-muted-foreground/40 cursor-not-allowed'
                    : 'text-foreground hover:bg-foreground/5'
                )}
              >
                <Icon className="size-3.5" />
                {option.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
