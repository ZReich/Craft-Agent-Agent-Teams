import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, XCircle, FileCode2, TestTube2, ClipboardList, Tickets } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface SpecTraceabilityPanelProps {
  traceabilityMap: Array<{
    requirementId: string
    files: string[]
    tests: string[]
    tasks: string[]
    tickets: string[]
  }>
  specRequirementIds?: string[]
  className?: string
}

type TraceabilityStatus = 'complete' | 'partial' | 'missing'

function getStatus(entry: SpecTraceabilityPanelProps['traceabilityMap'][number]): TraceabilityStatus {
  const hasFiles = entry.files.length > 0
  const hasTests = entry.tests.length > 0
  const hasTasks = entry.tasks.length > 0

  if (hasFiles && hasTests && hasTasks) return 'complete'
  if (hasFiles || hasTests || hasTasks) return 'partial'
  return 'missing'
}

function statusMeta(status: TraceabilityStatus) {
  if (status === 'complete') {
    return {
      icon: CheckCircle2,
      label: 'Complete',
      rowClass: 'border-green-500/20 bg-green-500/[0.03]',
      badgeClass: 'border-green-500/30 text-green-500',
    }
  }

  if (status === 'partial') {
    return {
      icon: AlertTriangle,
      label: 'Partial',
      rowClass: 'border-yellow-500/20 bg-yellow-500/[0.03]',
      badgeClass: 'border-yellow-500/30 text-yellow-500',
    }
  }

  return {
    icon: XCircle,
    label: 'Missing',
    rowClass: 'border-red-500/20 bg-red-500/[0.03]',
    badgeClass: 'border-red-500/30 text-red-500',
  }
}

function ItemPill({ icon: Icon, value, title }: { icon: React.ComponentType<{ className?: string }>; value: string; title: string }) {
  return (
    <span title={title} className="inline-flex items-center gap-1 rounded-md bg-foreground/[0.04] px-1.5 py-0.5 text-[10px] text-muted-foreground">
      <Icon className="size-2.5" />
      <span className="truncate max-w-48">{value}</span>
    </span>
  )
}

export function SpecTraceabilityPanel({ traceabilityMap, specRequirementIds = [], className }: SpecTraceabilityPanelProps) {
  const [expandedRows, setExpandedRows] = React.useState<Record<string, boolean>>({})
  const executionRequirementIds = React.useMemo(
    () => traceabilityMap.map((entry) => entry.requirementId),
    [traceabilityMap],
  )
  const specOnly = React.useMemo(
    () => specRequirementIds.filter((id) => !executionRequirementIds.includes(id)),
    [specRequirementIds, executionRequirementIds],
  )
  const executionOnly = React.useMemo(
    () => executionRequirementIds.filter((id) => !specRequirementIds.includes(id)),
    [executionRequirementIds, specRequirementIds],
  )
  const hasMismatch = specOnly.length > 0 || executionOnly.length > 0

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="px-4 py-3 border-b border-border bg-background/50">
        <h3 className="text-sm font-semibold">Spec Traceability</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Requirements • Files • Test refs • Tasks
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Note: test refs are linked files/patterns, not executed test runs.
        </p>
        <p className="text-[11px] text-muted-foreground mt-1">
          Spec: {specRequirementIds.length} • Execution: {executionRequirementIds.length}
        </p>
        {hasMismatch && (
          <p className="text-[11px] text-yellow-600 dark:text-yellow-400 mt-0.5">
            Mismatch detected • Spec-only: {specOnly.length} • Execution-only: {executionOnly.length}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {traceabilityMap.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <p className="text-xs">No traceability data yet</p>
          </div>
        ) : (
          <div className="min-w-[720px]">
            <div className="grid grid-cols-[220px_1fr_1fr_1fr_110px] text-[11px] text-muted-foreground uppercase tracking-wide px-3 py-2 border-b border-border bg-background/30 sticky top-0 z-10">
              <div>Requirement</div>
              <div>Files</div>
              <div>Test Refs</div>
              <div>Tasks</div>
              <div>Status</div>
            </div>

            <div className="p-2 space-y-1">
              {traceabilityMap.map((entry) => {
                const expanded = Boolean(expandedRows[entry.requirementId])
                const status = getStatus(entry)
                const meta = statusMeta(status)
                const StatusIcon = meta.icon

                return (
                  <div key={entry.requirementId} className={cn('rounded-lg border', meta.rowClass)}>
                    <button
                      type="button"
                      onClick={() => {
                        setExpandedRows(prev => ({
                          ...prev,
                          [entry.requirementId]: !expanded,
                        }))
                      }}
                      className="w-full grid grid-cols-[220px_1fr_1fr_1fr_110px] items-center gap-2 text-left px-2.5 py-2 hover:bg-foreground/[0.02] transition-colors"
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        {expanded ? <ChevronDown className="size-3 text-muted-foreground shrink-0" /> : <ChevronRight className="size-3 text-muted-foreground shrink-0" />}
                        <span className="text-xs font-medium truncate">{entry.requirementId}</span>
                      </div>

                      <div className="text-xs text-muted-foreground">{entry.files.length}</div>
                      <div className="text-xs text-muted-foreground">{entry.tests.length}</div>
                      <div className="text-xs text-muted-foreground">{entry.tasks.length}</div>

                      <div>
                        <Badge variant="outline" className={cn('text-[10px] h-4 px-1.5 py-0 inline-flex items-center gap-1', meta.badgeClass)}>
                          <StatusIcon className="size-2.5" />
                          {meta.label}
                        </Badge>
                      </div>
                    </button>

                    <AnimatePresence>
                      {expanded && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                          className="overflow-hidden border-t border-border/60"
                        >
                          <div className="px-3 py-2 space-y-2">
                            <div className="space-y-1">
                              <p className="text-[11px] font-medium text-muted-foreground">Files</p>
                              <div className="flex flex-wrap gap-1">
                                {entry.files.length > 0
                                  ? entry.files.map((file) => (
                                    <ItemPill key={file} icon={FileCode2} value={file} title={file} />
                                  ))
                                  : <span className="text-[11px] text-muted-foreground">No linked files</span>}
                              </div>
                            </div>

                            <div className="space-y-1">
                              <p className="text-[11px] font-medium text-muted-foreground">Test references</p>
                              <div className="flex flex-wrap gap-1">
                                {entry.tests.length > 0
                                  ? entry.tests.map((test) => (
                                    <ItemPill key={test} icon={TestTube2} value={test} title={test} />
                                  ))
                                  : <span className="text-[11px] text-muted-foreground">No linked test references</span>}
                              </div>
                            </div>

                            <div className="space-y-1">
                              <p className="text-[11px] font-medium text-muted-foreground">Tasks</p>
                              <div className="flex flex-wrap gap-1">
                                {entry.tasks.length > 0
                                  ? entry.tasks.map((task) => (
                                    <ItemPill key={task} icon={ClipboardList} value={task} title={task} />
                                  ))
                                  : <span className="text-[11px] text-muted-foreground">No linked tasks</span>}
                              </div>
                            </div>

                            {entry.tickets.length > 0 && (
                              <div className="space-y-1">
                                <p className="text-[11px] font-medium text-muted-foreground">Tickets</p>
                                <div className="flex flex-wrap gap-1">
                                  {entry.tickets.map((ticket) => (
                                    <ItemPill key={ticket} icon={Tickets} value={ticket} title={ticket} />
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
