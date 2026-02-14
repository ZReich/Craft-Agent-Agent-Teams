/**
 * ScheduledTaskDialog - Create/Edit dialog for scheduled tasks
 *
 * Provides a visual cron builder with presets (Daily, Weekly, Monthly, Custom)
 * and a prompt editor. Maps UI selections to/from cron expressions.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useRegisterModal } from '@/context/ModalContext'
import type { ScheduledTask } from '../../../shared/types'
import {
  detectPreset,
  parseCronTime,
  parseCronDays,
  parseCronDayOfMonth,
  buildCron,
  isValidCronFormat,
  DAYS_OF_WEEK,
  type SchedulePreset,
} from '@craft-agent/shared/cron'

// ============================================================================
// Types
// ============================================================================

interface ScheduledTaskDialogProps {
  open: boolean
  onClose: () => void
  onSave: (task: Omit<ScheduledTask, 'index' | 'scheduleDescription' | 'nextRun'>) => Promise<void>
  /** Existing task for editing (null for create) */
  task?: ScheduledTask | null
}

// ============================================================================
// Component
// ============================================================================

export function ScheduledTaskDialog({ open, onClose, onSave, task }: ScheduledTaskDialogProps) {
  const isEditing = !!task

  // Form state
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [preset, setPreset] = useState<SchedulePreset>('daily')
  const [hour, setHour] = useState(9)
  const [minute, setMinute] = useState(0)
  const [selectedDays, setSelectedDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [dayOfMonth, setDayOfMonth] = useState(1)
  const [customCron, setCustomCron] = useState('0 9 * * *')
  const [timezone, setTimezone] = useState('')
  const [isSaving, setIsSaving] = useState(false)

  useRegisterModal(open, onClose)

  // Initialize form from task (edit mode) or defaults (create mode)
  useEffect(() => {
    if (!open) return

    if (task) {
      setName(task.name || '')
      setPrompt(task.hooks.find(h => h.type === 'prompt')?.prompt || '')
      const p = detectPreset(task.cron)
      setPreset(p)
      const time = parseCronTime(task.cron)
      setHour(time.hour)
      setMinute(time.minute)
      setSelectedDays(parseCronDays(task.cron))
      setDayOfMonth(parseCronDayOfMonth(task.cron))
      setCustomCron(task.cron)
      setTimezone(task.timezone || '')
    } else {
      setName('')
      setPrompt('')
      setPreset('daily')
      setHour(9)
      setMinute(0)
      setSelectedDays([1, 2, 3, 4, 5])
      setDayOfMonth(1)
      setCustomCron('0 9 * * *')
      setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)
    }
  }, [open, task])

  const handleDayToggle = useCallback((day: number) => {
    setSelectedDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day]
    )
  }, [])

  const handleSave = async () => {
    const cron = buildCron(preset, hour, minute, selectedDays, dayOfMonth, customCron)
    setIsSaving(true)
    try {
      await onSave({
        name: name.trim() || undefined,
        cron,
        timezone: timezone || undefined,
        enabled: task?.enabled ?? true,
        hooks: [{ type: 'prompt', prompt }],
        labels: ['Scheduled'],
      })
      onClose()
    } catch (err) {
      console.error('[ScheduledTaskDialog] Save failed:', err)
    } finally {
      setIsSaving(false)
    }
  }

  const isValid = prompt.trim().length > 0 && (preset !== 'custom' || isValidCronFormat(customCron))

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEditing ? 'Edit Scheduled Task' : 'New Scheduled Task'}</DialogTitle>
          <DialogDescription>
            {isEditing ? 'Modify the schedule and prompt for this task.' : 'Create a recurring task that runs automatically.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Name */}
          <div className="space-y-1.5">
            <Label htmlFor="task-name" className="text-xs text-muted-foreground">Name (optional)</Label>
            <Input
              id="task-name"
              placeholder="e.g., Morning Briefing"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {/* Schedule Preset */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Schedule</Label>
            <div className="flex gap-1">
              {(['daily', 'weekly', 'monthly', 'custom'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={cn(
                    'flex-1 py-1.5 px-3 rounded-md text-xs font-medium transition-colors',
                    preset === p
                      ? 'bg-accent text-accent-foreground'
                      : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                  )}
                >
                  {p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* Time Picker (for daily/weekly/monthly) */}
          {preset !== 'custom' && (
            <div className="flex gap-3 items-end">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Time</Label>
                <div className="flex items-center gap-1">
                  <Select value={String(hour)} onValueChange={(v) => setHour(parseInt(v, 10))}>
                    <SelectTrigger className="w-[70px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Array.from({ length: 24 }, (_, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {i.toString().padStart(2, '0')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-muted-foreground">:</span>
                  <Select value={String(minute)} onValueChange={(v) => setMinute(parseInt(v, 10))}>
                    <SelectTrigger className="w-[70px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((m) => (
                        <SelectItem key={m} value={String(m)}>
                          {m.toString().padStart(2, '0')}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {timezone && (
                <span className="text-xs text-muted-foreground pb-2">{timezone.split('/').pop()?.replace(/_/g, ' ')}</span>
              )}
            </div>
          )}

          {/* Day of Week Picker (weekly) */}
          {preset === 'weekly' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Days</Label>
              <div className="flex gap-1">
                {DAYS_OF_WEEK.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => handleDayToggle(value)}
                    className={cn(
                      'flex-1 py-1.5 rounded-md text-xs font-medium transition-colors',
                      selectedDays.includes(value)
                        ? 'bg-accent text-accent-foreground'
                        : 'bg-foreground/5 text-muted-foreground hover:bg-foreground/10'
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Day of Month Picker (monthly) */}
          {preset === 'monthly' && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Day of Month</Label>
              <Select value={String(dayOfMonth)} onValueChange={(v) => setDayOfMonth(parseInt(v, 10))}>
                <SelectTrigger className="w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                    <SelectItem key={d} value={String(d)}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Custom Cron Input */}
          {preset === 'custom' && (
            <div className="space-y-1.5">
              <Label htmlFor="custom-cron" className="text-xs text-muted-foreground">
                Cron Expression (min hour day month weekday)
              </Label>
              <Input
                id="custom-cron"
                placeholder="0 9 * * 1-5"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                className="font-mono text-sm"
              />
            </div>
          )}

          {/* Prompt */}
          <div className="space-y-1.5">
            <Label htmlFor="task-prompt" className="text-xs text-muted-foreground">Prompt</Label>
            <textarea
              id="task-prompt"
              placeholder="What should the agent do? Use @mentions to reference sources or skills."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              className={cn(
                'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
                'placeholder:text-muted-foreground focus-visible:outline-none',
                'focus-visible:ring-1 focus-visible:ring-ring resize-none'
              )}
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!isValid || isSaving}
            onClick={handleSave}
          >
            {isSaving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Task'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
