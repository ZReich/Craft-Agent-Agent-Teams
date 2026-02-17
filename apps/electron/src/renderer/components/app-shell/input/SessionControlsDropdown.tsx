/**
 * SessionControlsDropdown — Implements REQ-001, REQ-002, REQ-003, REQ-004, REQ-005
 *
 * A dropdown in the chat input toolbar that provides per-session toggles
 * for Agent Teams, YOLO Mode, and Design Flow. Each toggle only appears
 * when that feature is enabled at the workspace level in settings.
 */

import * as React from 'react'
import { SlidersHorizontal, Users, Zap, Palette, Settings2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@craft-agent/ui'
import { cn } from '@/lib/utils'
import * as storage from '@/lib/local-storage'
import { navigate, routes } from '@/lib/navigate'


interface SessionControlsDropdownProps {
  /** Whether Agent Teams is enabled for this session */
  agentTeamsEnabled: boolean
  /** Callback when Agent Teams toggle changes — undefined means feature is off in settings (REQ-002) */
  onAgentTeamsChange?: (enabled: boolean) => void
  /** Whether YOLO Mode is enabled for this session */
  yoloModeEnabled: boolean
  /** Callback when YOLO Mode toggle changes — undefined means feature is off in settings (REQ-004) */
  onYoloModeChange?: (enabled: boolean) => void
  /** Whether Design Flow is enabled for this session */
  designFlowEnabled: boolean
  /** Callback when Design Flow toggle changes — undefined means feature is off in settings (REQ-004) */
  onDesignFlowChange?: (enabled: boolean) => void
}

export function SessionControlsDropdown({
  agentTeamsEnabled,
  onAgentTeamsChange,
  yoloModeEnabled,
  onYoloModeChange,
  designFlowEnabled,
  onDesignFlowChange,
}: SessionControlsDropdownProps) {
  const [open, setOpen] = React.useState(false)
  // Implements REQ-003: First-time YOLO confirmation gate
  const [showYoloConfirm, setShowYoloConfirm] = React.useState(false)

  // Only count features whose toggles are visible — Implements REQ-003
  const hasAnyActive =
    (onAgentTeamsChange && agentTeamsEnabled) ||
    (onYoloModeChange && yoloModeEnabled) ||
    (onDesignFlowChange && designFlowEnabled)

  // Build list of visible toggles for divider logic
  const visibleToggles: string[] = []
  if (onAgentTeamsChange) visibleToggles.push('teams')
  if (onYoloModeChange) visibleToggles.push('yolo')
  if (onDesignFlowChange) visibleToggles.push('design')

  // Implements REQ-002: Agent Teams toggle handler
  const handleAgentTeamsToggle = React.useCallback((checked: boolean) => {
    onAgentTeamsChange?.(checked)
  }, [onAgentTeamsChange])

  // Implements REQ-003: YOLO Mode toggle handler with first-time confirmation
  const handleYoloToggle = React.useCallback((checked: boolean) => {
    if (!checked) {
      onYoloModeChange?.(false)
      return
    }

    const hasConfirmed = storage.get<boolean>(storage.KEYS.yoloConfirmed, false)
    if (hasConfirmed) {
      onYoloModeChange?.(true)
    } else {
      setShowYoloConfirm(true)
    }
  }, [onYoloModeChange])

  const handleYoloConfirm = React.useCallback(() => {
    storage.set(storage.KEYS.yoloConfirmed, true)
    setShowYoloConfirm(false)
    onYoloModeChange?.(true)
  }, [onYoloModeChange])

  const handleYoloCancel = React.useCallback(() => {
    setShowYoloConfirm(false)
  }, [])

  // Implements REQ-005: Navigate to Agent Teams settings
  const handleOpenSettings = React.useCallback(() => {
    setOpen(false)
    navigate(routes.view.settings('agent-teams'))
  }, [])

  return (
    <Popover open={open} onOpenChange={(isOpen) => {
      setOpen(isOpen)
      if (!isOpen) setShowYoloConfirm(false)
    }}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
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
        {onAgentTeamsChange && (
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
        )}

        {/* Divider between Agent Teams and YOLO — only if both visible */}
        {onAgentTeamsChange && onYoloModeChange && (
          <div className="mx-3 border-t border-border/50" />
        )}

        {/* YOLO Mode Toggle — Implements REQ-003 */}
        {onYoloModeChange && (
          <div className="px-3 py-2">
            {showYoloConfirm ? (
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
        )}

        {/* Divider before Design Flow — only if Design Flow is visible and something is above it */}
        {onDesignFlowChange && (onAgentTeamsChange || onYoloModeChange) && (
          <div className="mx-3 border-t border-border/50" />
        )}

        {/* Design Flow Toggle — Implements REQ-004 */}
        {onDesignFlowChange && (
          <div className="px-3 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <Palette className={cn(
                  "h-4 w-4 shrink-0",
                  designFlowEnabled ? "text-accent" : "text-muted-foreground"
                )} />
                <div className="min-w-0">
                  <div className="text-[13px] font-medium leading-tight">Design Flow</div>
                  <div className="text-[11px] text-muted-foreground leading-tight mt-0.5">Multi-variant UI generation</div>
                </div>
              </div>
              <Switch
                checked={designFlowEnabled}
                onCheckedChange={onDesignFlowChange}
                className="shrink-0 ml-3"
              />
            </div>
          </div>
        )}

        {/* Divider before settings link — Implements REQ-005 */}
        <div className="mx-3 border-t border-border/50" />

        {/* Configure in Settings link — Implements REQ-005 */}
        <div className="px-3 py-2">
          <button
            type="button"
            onClick={handleOpenSettings}
            className="flex items-center gap-2 w-full text-left group"
          >
            <Settings2 className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
            <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
              Configure in Settings
            </span>
          </button>
        </div>

        {/* Bottom padding */}
        <div className="h-0.5" />
      </PopoverContent>
    </Popover>
  )
}
