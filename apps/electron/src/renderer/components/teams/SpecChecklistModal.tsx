/**
 * SpecChecklistModal
 *
 * Modal shown before finalizing a team session with SDD mode active.
 * Displays a checklist of all spec requirements with their completion
 * status so the user can verify everything is addressed.
 */

import * as React from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  User,
  ListChecks,
  TestTube2,
  Link2,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export interface SpecChecklistModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  requirements: Array<{
    id: string
    description: string
    priority: 'critical' | 'high' | 'medium' | 'low'
    status: 'pending' | 'in-progress' | 'implemented' | 'verified'
    linkedTaskIds?: string[]
    linkedTestPatterns?: string[]
    assignedDRI?: string
  }>
  coveragePercent: number
  onConfirmComplete: () => void
  onGoBack: () => void
  isBlocked?: boolean
  blockReason?: string
}

function priorityColor(priority: string): string {
  switch (priority) {
    case 'critical': return 'border-red-500/30 text-red-500'
    case 'high': return 'border-orange-500/30 text-orange-500'
    case 'medium': return 'border-blue-500/30 text-blue-500'
    default: return 'border-border text-muted-foreground'
  }
}

function isComplete(status: string): boolean {
  return status === 'implemented' || status === 'verified'
}

function progressBarColor(percent: number): string {
  if (percent >= 100) return 'bg-green-500'
  if (percent >= 70) return 'bg-yellow-500'
  return 'bg-red-500'
}

export function SpecChecklistModal({
  open,
  onOpenChange,
  requirements,
  coveragePercent,
  onConfirmComplete,
  onGoBack,
  isBlocked = false,
  blockReason,
}: SpecChecklistModalProps) {
  const completedCount = requirements.filter(r => isComplete(r.status)).length

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="size-4" />
            Spec Completion Checklist
          </DialogTitle>
          <DialogDescription>
            {completedCount}/{requirements.length} requirements addressed
          </DialogDescription>
        </DialogHeader>

        {/* Coverage progress bar */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Coverage</span>
            <span className="font-medium">{coveragePercent}%</span>
          </div>
          <div className="h-2 rounded-full bg-foreground/5 overflow-hidden">
            <div
              className={cn('h-full rounded-full transition-all duration-500', progressBarColor(coveragePercent))}
              style={{ width: `${Math.min(coveragePercent, 100)}%` }}
            />
          </div>
        </div>

        {/* Requirements checklist */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1 py-2">
          <AnimatePresence mode="popLayout">
            {requirements.map((req, i) => {
              const done = isComplete(req.status)
              const taskCount = req.linkedTaskIds?.length || 0
              const testCount = req.linkedTestPatterns?.length || 0

              return (
                <motion.div
                  key={req.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ delay: i * 0.03 }}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md px-2.5 py-2 text-xs',
                    done ? 'bg-green-500/5' : 'bg-foreground/[0.02]'
                  )}
                >
                  {/* Check icon */}
                  {done ? (
                    <CheckCircle2 className="size-4 text-green-500 mt-0.5 shrink-0" />
                  ) : req.status === 'in-progress' ? (
                    <AlertTriangle className="size-4 text-yellow-500 mt-0.5 shrink-0" />
                  ) : (
                    <XCircle className="size-4 text-muted-foreground/40 mt-0.5 shrink-0" />
                  )}

                  {/* Content */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono font-medium text-foreground">{req.id}</span>
                      <Badge variant="outline" className={cn('text-[10px] px-1 py-0', priorityColor(req.priority))}>
                        {req.priority}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground line-clamp-2">{req.description}</p>
                    <div className="flex items-center gap-3 text-muted-foreground/60">
                      {req.assignedDRI && (
                        <span className="flex items-center gap-1">
                          <User className="size-3" />
                          {req.assignedDRI}
                        </span>
                      )}
                      <span className="flex items-center gap-1">
                        <Link2 className="size-3" />
                        {taskCount} task{taskCount !== 1 ? 's' : ''}
                      </span>
                      <span className="flex items-center gap-1">
                        <TestTube2 className="size-3" />
                        {testCount} test{testCount !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  {/* Status */}
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[10px] shrink-0',
                      done ? 'border-green-500/30 text-green-500' : 'border-border text-muted-foreground'
                    )}
                  >
                    {req.status}
                  </Badge>
                </motion.div>
              )
            })}
          </AnimatePresence>
        </div>

        {/* Blocked banner */}
        {isBlocked && blockReason && (
          <div className="rounded-md bg-red-500/10 border border-red-500/20 px-3 py-2 text-xs text-red-500">
            {blockReason}
          </div>
        )}

        {/* Warning when not blocked but not fully covered */}
        {!isBlocked && coveragePercent < 100 && (
          <div className="rounded-md bg-yellow-500/10 border border-yellow-500/20 px-3 py-2 text-xs text-yellow-600">
            Some requirements are not fully covered. Continue anyway?
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onGoBack}>
            Go Back
          </Button>
          <Button
            size="sm"
            disabled={isBlocked}
            onClick={onConfirmComplete}
            className={cn(!isBlocked && 'bg-green-600 hover:bg-green-700 text-white')}
          >
            Confirm Complete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
