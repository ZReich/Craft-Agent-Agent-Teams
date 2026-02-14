/**
 * useScheduledTasks Hook
 *
 * React hook that loads scheduled tasks (SchedulerTick entries from hooks.json),
 * subscribes to live changes, and provides CRUD operations.
 */

import { useState, useEffect, useCallback } from 'react'
import type { ScheduledTask } from '../../shared/types'

export interface UseScheduledTasksResult {
  /** List of scheduled tasks */
  tasks: ScheduledTask[]
  /** Loading state */
  isLoading: boolean
  /** Create a new scheduled task */
  createTask: (task: Omit<ScheduledTask, 'index' | 'scheduleDescription' | 'nextRun'>) => Promise<ScheduledTask>
  /** Update an existing scheduled task */
  updateTask: (index: number, task: Omit<ScheduledTask, 'index' | 'scheduleDescription' | 'nextRun'>) => Promise<ScheduledTask>
  /** Delete a scheduled task by index */
  deleteTask: (index: number) => Promise<void>
  /** Toggle enabled/disabled state */
  toggleTask: (index: number) => Promise<ScheduledTask>
  /** Force re-fetch from IPC */
  refresh: () => Promise<void>
}

export function useScheduledTasks(workspaceId: string | null): UseScheduledTasksResult {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [isLoading, setIsLoading] = useState(true)

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setTasks([])
      setIsLoading(false)
      return
    }

    try {
      setIsLoading(true)
      const result = await window.electronAPI.listScheduledTasks(workspaceId)
      setTasks(result)
    } catch (err) {
      console.error('[useScheduledTasks] Failed to load:', err)
    } finally {
      setIsLoading(false)
    }
  }, [workspaceId])

  // Load on workspace change
  useEffect(() => {
    refresh()
  }, [refresh])

  // Subscribe to live changes
  useEffect(() => {
    if (!workspaceId) return

    const cleanup = window.electronAPI.onScheduledTasksChanged((changedWorkspaceId) => {
      if (changedWorkspaceId === workspaceId) {
        refresh()
      }
    })

    return cleanup
  }, [workspaceId, refresh])

  const createTask = useCallback(async (task: Omit<ScheduledTask, 'index' | 'scheduleDescription' | 'nextRun'>) => {
    if (!workspaceId) throw new Error('No workspace')
    return window.electronAPI.createScheduledTask(workspaceId, task)
  }, [workspaceId])

  const updateTask = useCallback(async (index: number, task: Omit<ScheduledTask, 'index' | 'scheduleDescription' | 'nextRun'>) => {
    if (!workspaceId) throw new Error('No workspace')
    return window.electronAPI.updateScheduledTask(workspaceId, index, task)
  }, [workspaceId])

  const deleteTask = useCallback(async (index: number) => {
    if (!workspaceId) throw new Error('No workspace')
    return window.electronAPI.deleteScheduledTask(workspaceId, index)
  }, [workspaceId])

  const toggleTask = useCallback(async (index: number) => {
    if (!workspaceId) throw new Error('No workspace')
    return window.electronAPI.toggleScheduledTask(workspaceId, index)
  }, [workspaceId])

  return {
    tasks,
    isLoading,
    createTask,
    updateTask,
    deleteTask,
    toggleTask,
    refresh,
  }
}
