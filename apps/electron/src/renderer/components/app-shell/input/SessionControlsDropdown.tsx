/**
 * SessionControlsDropdown — Implements REQ-001, REQ-002, REQ-003, REQ-004
 *
 * A dropdown in the chat input toolbar that provides per-session toggles
 * for Agent Teams and YOLO Mode. Uses Popover + Switch pattern consistent
 * with the codebase's existing dropdown components.
 */

import * as React from 'react'
import { SlidersHorizontal, Users, Zap } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'


interface SessionControlsDropdownProps {
  /** Whether Agent Teams is enabled for this session */
  agentTeamsEnabled: boolean
  /** Callback when Agent Teams toggle changes */
  onAgentTeamsChange: (enabled: boolean) => void
  /** Whether YOLO Mode is enabled for this session */
  yoloModeEnabled: boolean
  /** Callback when YOLO Mode toggle changes */
  onYoloModeChange: (enabled: boolean) => void
}

export function SessionControlsDropdown({
  agentTeamsEnabled,
  onAgentTeamsChange,
  yoloModeEnabled,
  onYoloModeChange,
}: SessionControlsDropdownProps) {
  const [open, setOpen] = React.useState(false)
  // Implements REQ-003: First-time YOLO confirmation gate
  const [showYoloConfirm, setShowYoloConfirm] = React.useState(false)

  const hasAnyActive = agentTeamsEnabled || yoloModeEnabled

  // Implements REQ-002: Agent Teams toggle handler
  const handleAgentTeamsToggle = React.useCallback((checked: boolean) => {
    onAgentTeamsChange(checked)
  }, [onAgentTeamsChange])

  // Implements REQ-003: YOLO Mode toggle handler with first-time confirmation
  const handleYoloToggle = React.useCallback((checked: boolean) => {
    if (!checked) {
      // Turning off - no confirmation needed
      onYoloModeChange(false)
      return
    }

    // Turning on - check if user has confirmed before
    const hasConfirmed = storage.get<boolean>(storage.KEYS.yoloConfirmed, false)
    if (hasConfirmed) {
      onYoloModeChange(true)
    } else {
      setShowYoloConfirm(true)
    }
  }, [onYoloModeChange])

  // Implements REQ-003: Confirm YOLO activation (first time only)
  const handleYoloConfirm = React.useCallback(() => {
    storage.set(storage.KEYS.yoloConfirmed, true)
    setShowYoloConfirm(false)
    onYoloModeChange(true)
  }, [onYoloModeChange])

  const handleYoloCancel = React.useCallback(() => {
    setShowYoloConfirm(false)
  }, [])

  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen)
      // Reset confirmation state when closing
      if (!isOpen) setShowYoloConfirm(false)
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            {/* Implements REQ-004: Icon state indicator */}
            <button
              type="button"
              className={cn(
                "relative inline-flex items-center justify-center h-7 w-7 rounded-[6px] transition-colors select-none",
                "hover:bg-foreground/5",
                open && "bg-foreground/5",
                hasAnyActive
                  ? "text-accent"
                  : "text-muted-foreground"
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {/* Active indicator dot — Implements REQ-004 */}
              {hasAnyActive && (
                <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Session Controls</TooltipContent>
      </Tooltip>

      <PopoverContent
        className="w-[260px] p-0 bg-background/80 backdrop-blur-xl backdrop-saturate-150 border-border/50"
        side="top"
        align="end"
        sideOffset={8}
        style={{ borderRadius: '10px', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)' }}
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          window.dispatchEvent(new CustomEvent('craft:focus-input'))
        }}
      >
        {/* Header */}
        <div className="px-3 pt-3 pb-1.5">
          <div className="text-xs font-medium text-muted-foreground select-none">
            Session Controls
          </div>
        </div>

        {/* Agent Teams Toggle — Implements REQ-002 */}
        <div className="px-3 py-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5 min-w-0">
              <Users className={cn(
                "h-4 w-4 shrink-0",
                agentTeamsEnabled ? "text-accent" : "text-muted-foreground"
              )} />
              <div className="min-w-0">
                <div className="text-[13px] font-medium leading-tight">Agent Teams</div>
                <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">Multi-agent collaboration</div>
              </div>
            </div>
            <Switch
              checked={agentTeamsEnabled}
              onCheckedChange={handleAgentTeamsToggle}
              className="shrink-0 ml-3"
            />
          </div>
        </div>

        {/* Divider */}
        <div className="mx-3 border-t border-border/50" />

        {/* YOLO Mode Toggle — Implements REQ-003 */}
        <div className="px-3 py-2">
          {showYoloConfirm ? (
            /* First-time confirmation — Implements REQ-003 */
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-warning shrink-0" />
                <div className="text-[13px] font-medium">Enable YOLO Mode?</div>
              </div>
              <div className="text-[11px] text-muted-foreground leading-relaxed pl-6">
                Actions will execute without confirmation prompts. You can turn this off at any time.
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={handleYoloCancel}
                  className="h-7 px-3 text-xs font-medium rounded-[6px] bg-foreground/5 hover:bg-foreground/10 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleYoloConfirm}
                  className="h-7 px-3 text-xs font-medium rounded-[6px] bg-accent text-accent-foreground hover:bg-accent/90 transition-colors"
                >
                  Enable YOLO
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <Zap className={cn(
                  "h-4 w-4 shrink-0",
                  yoloModeEnabled ? "text-accent" : "text-muted-foreground"
                )} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-tight">YOLO Mode</div>
                  <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">Autonomous execution</div>
                </div>
              </div>
              <Switch
                checked={yoloModeEnabled}
                onCheckedChange={handleYoloToggle}
                className="shrink-0 ml-3"
              />
            </div>
          )}
        </div>

        {/* Bottom padding */}
        <div className="h-1" />
      </PopoverContent>
    </Popover>
  )
}
