/**
 * ModelSwapDialog
 *
 * Dialog for live model swapping on a teammate.
 * Shows available models with cost comparison and allows mid-task swap.
 */

import * as React from 'react'
import { useState, useCallback } from 'react'
import { ArrowRight, Check } from 'lucide-react'
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
import type { AgentTeammate } from '../../../shared/types'

export interface ModelSwapDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  teammate: AgentTeammate
  onSwap: (teammateId: string, newModel: string, newProvider: string) => void
}

interface ModelOption {
  id: string
  name: string
  provider: string
  costInput: number
  costOutput: number
  description: string
}

const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'claude-opus-4-6', name: 'Opus 4.6', provider: 'anthropic', costInput: 15, costOutput: 75, description: 'Most capable, best for complex reasoning' },
  { id: 'claude-sonnet-4-5-20250929', name: 'Sonnet 4.5', provider: 'anthropic', costInput: 3, costOutput: 15, description: 'Best balance of speed and quality' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', provider: 'anthropic', costInput: 0.8, costOutput: 4, description: 'Fastest, good for simple tasks' },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', provider: 'moonshot', costInput: 1.5, costOutput: 7.5, description: 'Cost-effective with tool use support' },
]

export function ModelSwapDialog({
  open,
  onOpenChange,
  teammate,
  onSwap,
}: ModelSwapDialogProps) {
  const [selectedModel, setSelectedModel] = useState(teammate.model)

  const currentModel = AVAILABLE_MODELS.find(m => m.id === teammate.model)
  const newModel = AVAILABLE_MODELS.find(m => m.id === selectedModel)

  const handleSwap = useCallback(() => {
    if (!newModel || selectedModel === teammate.model) return
    onSwap(teammate.id, newModel.id, newModel.provider)
    onOpenChange(false)
  }, [selectedModel, teammate, newModel, onSwap, onOpenChange])

  const costDiff = newModel && currentModel
    ? ((newModel.costInput + newModel.costOutput) / 2) - ((currentModel.costInput + currentModel.costOutput) / 2)
    : 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Swap Model</DialogTitle>
          <DialogDescription>
            Change the model for {teammate.name}. Context carries over via task re-injection.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          {/* Current model indicator */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-3">
            <span>Current: <strong className="text-foreground">{currentModel?.name || teammate.model}</strong></span>
            {selectedModel !== teammate.model && newModel && (
              <>
                <ArrowRight className="size-3" />
                <span>New: <strong className="text-foreground">{newModel.name}</strong></span>
              </>
            )}
          </div>

          {/* Model options */}
          {AVAILABLE_MODELS.map((model) => {
            const isSelected = model.id === selectedModel
            const isCurrent = model.id === teammate.model

            return (
              <button
                key={model.id}
                type="button"
                onClick={() => setSelectedModel(model.id)}
                className={cn(
                  'w-full flex items-center justify-between rounded-lg border p-3 text-left transition-colors',
                  isSelected
                    ? 'border-foreground/30 bg-foreground/5'
                    : 'border-border hover:border-foreground/20 hover:bg-foreground/[0.02]'
                )}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{model.name}</span>
                    {isCurrent && (
                      <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4">
                        Current
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{model.description}</p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    ${model.costInput}/${model.costOutput} per 1M tokens
                  </p>
                </div>
                {isSelected && <Check className="size-4 text-foreground shrink-0 ml-3" />}
              </button>
            )
          })}

          {/* Cost impact */}
          {selectedModel !== teammate.model && costDiff !== 0 && (
            <div className="flex items-center justify-between rounded-lg bg-foreground/5 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Cost impact</span>
              <span className={costDiff > 0 ? 'text-yellow-500' : 'text-green-500'}>
                {costDiff > 0 ? '+' : ''}{costDiff.toFixed(1)} avg cost/1M tokens
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSwap} disabled={selectedModel === teammate.model}>
            Swap Model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
