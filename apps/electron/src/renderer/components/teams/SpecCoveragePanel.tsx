import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { CheckCircle2, AlertTriangle, XCircle, Link2, TestTube2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface SpecCoveragePanelProps {
  requirements: Array<{
    id: string
    description: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    status: 'pending' | 'in-progress' | 'implemented' | 'verified'
    linkedTaskIds?: string[]
    linkedTestPatterns?: string[]
  }>
  className?: string
  onRequirementClick?: (requirementId: string) => void
}

type CoverageState = 'full' | 'partial' | 'none'

function getCoverageState(requirement: SpecCoveragePanelProps['requirements'][number]): CoverageState {
  const hasTasks = (requirement.linkedTaskIds?.length || 0) > 0
  const hasTests = (requirement.linkedTestPatterns?.length || 0) > 0

  if (hasTasks && hasTests) return 'full'
  if (hasTasks || hasTests) return 'partial'
  return 'none'
}

function coverageLabel(state: CoverageState): string {
  if (state === 'full') return 'Covered'
  if (state === 'partial') return 'Partial'
  return 'Missing'
}

function coverageIcon(state: CoverageState) {
  if (state === 'full') return CheckCircle2
  if (state === 'partial') return AlertTriangle
  return XCircle
}

function coverageColor(state: CoverageState): string {
  if (state === 'full') return 'text-green-500'
  if (state === 'partial') return 'text-yellow-500'
  return 'text-destructive'
}

function priorityClass(priority: SpecCoveragePanelProps['requirements'][number]['priority']): string {
  switch (priority) {
    case 'critical':
      return 'border-red-500/30 text-red-500'
    case 'high':
      return 'border-orange-500/30 text-orange-500'
    case 'medium':
      return 'border-blue-500/30 text-blue-500'
    case 'low':
    default:
      return 'border-border text-muted-foreground'
  }
}

export function SpecCoveragePanel({ requirements, className, onRequirementClick }: SpecCoveragePanelProps) {
  const [selectedRequirementId, setSelectedRequirementId] = React.useState<string | null>(null)

  const { fullCount, partialCount, noneCount, coveragePercent } = React.useMemo(() => {
    let full = 0
    let partial = 0
    let none = 0

    requirements.forEach((requirement) => {
      const state = getCoverageState(requirement)
      if (state === 'full') full += 1
      else if (state === 'partial') partial += 1
      else none += 1
    })

    const total = requirements.length
    const percent = total === 0 ? 0 : Math.round((full / total) * 100)

    return {
      fullCount: full,
      partialCount: partial,
      noneCount: none,
      coveragePercent: percent,
    }
  }, [requirements])

  return (
    <div className={cn('flex flex-col h-full', className)}>
      <div className="p-4 border-b border-border bg-background/50">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Spec Coverage</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {fullCount}/{requirements.length} requirements fully covered
            </p>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">{coveragePercent}%</div>
            <div className="text-[11px] text-muted-foreground">overall</div>
          </div>
        </div>

        <div className="mt-3 h-2 w-full rounded-full bg-foreground/10 overflow-hidden">
          <motion.div
            className="h-full bg-green-500"
            initial={{ width: 0 }}
            animate={{ width: `${coveragePercent}%` }}
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
          />
        </div>

        <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="size-3 text-green-500" />
            {fullCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="size-3 text-yellow-500" />
            {partialCount}
          </span>
          <span className="inline-flex items-center gap-1">
            <XCircle className="size-3 text-destructive" />
            {noneCount}
          </span>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {requirements.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <p className="text-xs">No requirements yet</p>
          </div>
        ) : (
          requirements.map((requirement, index) => {
            const coverageState = getCoverageState(requirement)
            const CoverageIcon = coverageIcon(coverageState)
            const isSelected = selectedRequirementId === requirement.id

            return (
              <motion.button
                key={requirement.id}
                type="button"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, delay: index * 0.02 }}
                onClick={() => {
                  setSelectedRequirementId(requirement.id)
                  onRequirementClick?.(requirement.id)
                }}
                className={cn(
                  'w-full text-left rounded-lg border px-3 py-2 transition-colors',
                  isSelected
                    ? 'border-blue-500/30 bg-blue-500/5'
                    : 'border-border hover:bg-foreground/[0.02]'
                )}
              >
                <div className="flex items-start gap-2">
                  <CoverageIcon className={cn('size-4 mt-0.5 shrink-0', coverageColor(coverageState))} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-medium">{requirement.id}</span>
                      <Badge variant="outline" className={cn('text-[10px] h-4 px-1.5 py-0', priorityClass(requirement.priority))}>
                        {requirement.priority}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] h-4 px-1.5 py-0 border-border">
                        {coverageLabel(coverageState)}
                      </Badge>
                    </div>

                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {requirement.description}
                    </p>

                    <AnimatePresence>
                      {isSelected && (
                        <motion.div
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
                          className="overflow-hidden"
                        >
                          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                            <span className="inline-flex items-center gap-1">
                              <Link2 className="size-3" />
                              {requirement.linkedTaskIds?.length || 0} tasks
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <TestTube2 className="size-3" />
                              {requirement.linkedTestPatterns?.length || 0} tests
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
              </motion.button>
            )
          })
        )}
      </div>
    </div>
  )
}
