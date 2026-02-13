/**
 * CommandCenter
 *
 * Top-level shell for agent teams interface.
 * Provides a Command Center view with team card grid and overview.
 * This is the Phase 1 scaffold for multi-team management.
 */

import * as React from 'react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Users, Activity, TrendingUp } from 'lucide-react'

export interface CommandCenterProps {
  /** Child content (typically TeamCardGrid) */
  children?: React.ReactNode
  /** Title for the command center */
  title?: string
  /** Optional stats to display in header */
  stats?: {
    activeTeams: number
    totalMembers: number
    activeTasks: number
  }
  /** Optional actions/controls in header */
  headerActions?: React.ReactNode
  /** Additional className */
  className?: string
}

export function CommandCenter({
  children,
  title = 'Command Center',
  stats,
  headerActions,
  className,
}: CommandCenterProps) {
  return (
    <div className={cn('flex flex-col h-full bg-background', className)}>
      {/* Header */}
      <div className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              {stats && (
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <Users className="size-4" />
                    <span>{stats.activeTeams} {stats.activeTeams === 1 ? 'team' : 'teams'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Activity className="size-4" />
                    <span>{stats.totalMembers} {stats.totalMembers === 1 ? 'member' : 'members'}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="size-4" />
                    <span>{stats.activeTasks} active {stats.activeTasks === 1 ? 'task' : 'tasks'}</span>
                  </div>
                </div>
              )}
            </div>
            {headerActions && (
              <div className="flex items-center gap-2">
                {headerActions}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6">
          {children}
        </div>
      </div>
    </div>
  )
}
