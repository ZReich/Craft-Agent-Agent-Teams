/**
 * TeamCreationDialog
 *
 * Modal dialog for creating a new agent team.
 * Allows configuring team name, teammates (name, role, model), preset selection,
 * and shows a live cost estimate.
 */

import * as React from 'react'
import { useState, useCallback, useMemo } from 'react'
import { Plus, Trash2 } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ModelPresetId } from '../../../shared/types'

interface TeammateConfig {
  name: string
  role: string
  model: string
}

export interface TeamCreationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreateTeam: (config: {
    name: string
    teammates: TeammateConfig[]
    preset: ModelPresetId
  }) => void
}

const PRESET_OPTIONS: { id: ModelPresetId; name: string; cost: string; description: string }[] = [
  { id: 'cost-optimized', name: 'Cost Optimized', cost: '$$', description: 'Opus lead, Kimi workers' },
  { id: 'balanced', name: 'Balanced', cost: '$$$', description: 'Opus lead, Sonnet workers' },
  { id: 'max-quality', name: 'Max Quality', cost: '$$$$', description: 'Opus everywhere' },
  { id: 'budget', name: 'Budget', cost: '$', description: 'Sonnet lead, Kimi workers' },
]

const DEFAULT_TEAMMATES: TeammateConfig[] = [
  { name: 'Frontend', role: 'frontend-specialist', model: 'auto' },
  { name: 'Backend', role: 'backend-specialist', model: 'auto' },
  { name: 'Tests', role: 'test-engineer', model: 'auto' },
]

export function TeamCreationDialog({
  open,
  onOpenChange,
  onCreateTeam,
}: TeamCreationDialogProps) {
  const [teamName, setTeamName] = useState('')
  const [selectedPreset, setSelectedPreset] = useState<ModelPresetId>('cost-optimized')
  const [teammates, setTeammates] = useState<TeammateConfig[]>(DEFAULT_TEAMMATES)

  const handleAddTeammate = useCallback(() => {
    setTeammates(prev => [...prev, { name: '', role: '', model: 'auto' }])
  }, [])

  const handleRemoveTeammate = useCallback((index: number) => {
    setTeammates(prev => prev.filter((_, i) => i !== index))
  }, [])

  const handleTeammateChange = useCallback(
    (index: number, field: keyof TeammateConfig, value: string) => {
      setTeammates(prev =>
        prev.map((t, i) => (i === index ? { ...t, [field]: value } : t))
      )
    },
    []
  )

  const costEstimate = useMemo(() => {
    const costMap: Record<ModelPresetId, number> = {
      'max-quality': 22.5 * teammates.length,
      'balanced': 7.5 + 3.75 * teammates.length,
      'cost-optimized': 7.5 + 1.425 * teammates.length,
      'budget': 2.25 + 1.425 * teammates.length,
      'custom': 3.75 * teammates.length,
    }
    return (costMap[selectedPreset] || 5).toFixed(2)
  }, [selectedPreset, teammates.length])

  const handleCreate = useCallback(() => {
    const validTeammates = teammates.filter(t => t.name.trim())
    if (validTeammates.length === 0) return
    onCreateTeam({
      name: teamName.trim() || 'Untitled Team',
      teammates: validTeammates,
      preset: selectedPreset,
    })
    // Reset
    setTeamName('')
    setTeammates(DEFAULT_TEAMMATES)
    setSelectedPreset('cost-optimized')
  }, [teamName, teammates, selectedPreset, onCreateTeam])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create Agent Team</DialogTitle>
          <DialogDescription>
            Configure your team of AI agents. The lead agent orchestrates, teammates execute tasks.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Team Name */}
          <div className="space-y-2">
            <Label htmlFor="team-name">Team Name</Label>
            <Input
              id="team-name"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g., Feature Implementation"
            />
          </div>

          {/* Preset Selection */}
          <div className="space-y-2">
            <Label>Model Preset</Label>
            <div className="grid grid-cols-2 gap-2">
              {PRESET_OPTIONS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => setSelectedPreset(preset.id)}
                  className={cn(
                    'flex flex-col items-start rounded-lg border p-3 text-left transition-colors',
                    selectedPreset === preset.id
                      ? 'border-foreground/30 bg-foreground/5'
                      : 'border-border hover:border-foreground/20 hover:bg-foreground/[0.02]'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{preset.name}</span>
                    <span className="text-xs text-muted-foreground">{preset.cost}</span>
                  </div>
                  <span className="text-xs text-muted-foreground mt-0.5">{preset.description}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Teammates */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Teammates</Label>
              <Button variant="ghost" size="sm" onClick={handleAddTeammate} className="h-7 gap-1 text-xs">
                <Plus className="size-3" />
                Add
              </Button>
            </div>
            <div className="space-y-2">
              {teammates.map((teammate, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    value={teammate.name}
                    onChange={(e) => handleTeammateChange(index, 'name', e.target.value)}
                    placeholder="Name"
                    className="flex-1"
                  />
                  <Input
                    value={teammate.role}
                    onChange={(e) => handleTeammateChange(index, 'role', e.target.value)}
                    placeholder="Role"
                    className="flex-1"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveTeammate(index)}
                    className="shrink-0 size-8 text-muted-foreground hover:text-destructive"
                    disabled={teammates.length <= 1}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          {/* Cost Estimate */}
          <div className="flex items-center justify-between rounded-lg bg-foreground/5 px-3 py-2">
            <span className="text-sm text-muted-foreground">Estimated hourly cost</span>
            <Badge variant="secondary">~${costEstimate}/hr</Badge>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={teammates.filter(t => t.name.trim()).length === 0}>
            Create Team
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
