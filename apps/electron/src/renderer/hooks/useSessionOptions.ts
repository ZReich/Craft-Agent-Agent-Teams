/**
 * Session Options Types
 *
 * Type definitions and helpers for session-scoped settings.
 * The actual hook is in AppShellContext.tsx as useSessionOptionsFor().
 *
 * ADDING A NEW SESSION OPTION:
 * 1. Add field to SessionOptions interface below
 * 2. Update defaultSessionOptions
 * 3. Add UI control in FreeFormInput.tsx (or wherever needed)
 */

import type { PermissionMode } from '../../shared/types'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import { DEFAULT_THINKING_LEVEL } from '@craft-agent/shared/agent/thinking-levels'

/**
 * All session-scoped options in one place.
 */
export interface SessionOptions {
  /** Extended thinking mode (single-shot per message) - boosts to max thinking for one message */
  ultrathinkEnabled: boolean
  /** Permission mode ('safe', 'ask', 'allow-all') */
  permissionMode: PermissionMode
  /** Session-level thinking level ('off', 'think', 'max') - sticky, persisted */
  thinkingLevel: ThinkingLevel
  /** Whether Agent Teams is enabled for this session — Implements REQ-002 */
  agentTeamsEnabled: boolean
  /** Whether YOLO Mode (autonomous execution) is enabled for this session — Implements REQ-003 */
  yoloModeEnabled: boolean
  /** Permission mode to restore when YOLO Mode is toggled off */
  preYoloPermissionMode?: PermissionMode
}

/** Default values for new sessions */
export const defaultSessionOptions: SessionOptions = {
  ultrathinkEnabled: false,
  permissionMode: 'ask', // Default to ask mode (prompt for permissions)
  thinkingLevel: DEFAULT_THINKING_LEVEL, // Default to 'think' level
  agentTeamsEnabled: false,
  yoloModeEnabled: false,
}

/** Type for partial updates to session options */
export type SessionOptionUpdates = Partial<SessionOptions>

/** Helper to merge session options with updates */
export function mergeSessionOptions(
  current: SessionOptions | undefined,
  updates: SessionOptionUpdates
): SessionOptions {
  return {
    ...defaultSessionOptions,
    ...current,
    ...updates,
  }
}

