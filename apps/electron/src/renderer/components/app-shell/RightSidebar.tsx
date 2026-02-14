/**
 * RightSidebar - Content router for right sidebar panels
 *
 * Routes to different panel types based on RightSidebarPanel discriminated union.
 * Similar to how MainContentPanel routes between different page types.
 */

import * as React from 'react'
import type { RightSidebarPanel } from '../../../shared/types'
import { SessionFilesSection } from '../right-sidebar/SessionFilesSection'
import { SessionHistoryPanel } from '../right-sidebar/SessionHistoryPanel'
import { SessionMetadataPanel } from '../right-sidebar/SessionMetadataPanel'

export interface RightSidebarProps {
  /** Current panel configuration */
  panel: RightSidebarPanel
  /** Session ID (required for session-specific panels) */
  sessionId?: string
  /** Close button to display in panel header */
  closeButton?: React.ReactNode
}

/**
 * Routes right sidebar content based on panel type
 */
export function RightSidebar({ panel, sessionId, closeButton }: RightSidebarProps) {
  switch (panel.type) {
    case 'sessionMetadata':
      return <SessionMetadataPanel sessionId={sessionId} closeButton={closeButton} />

    case 'files':
      return <SessionFilesSection sessionId={sessionId} className="h-full" />

    case 'history':
      return <SessionHistoryPanel sessionId={sessionId} closeButton={closeButton} />

    case 'none':
    default:
      return null
  }
}
