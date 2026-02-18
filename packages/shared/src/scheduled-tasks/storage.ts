/**
 * Scheduled Tasks Storage
 *
 * CRUD operations for SchedulerTick entries in hooks.json.
 * Each scheduled task is a HookMatcher entry under the "SchedulerTick" event key.
 *
 * Extended fields (name, description) are stored directly in the matcher object.
 * They are ignored by the hook system's Zod validation (passthrough) but preserved
 * when we read/write the JSON.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cronToHuman, getNextRun } from './cron-utils.ts';
import { validateScheduledTask, validateTaskIndex } from './validation.ts';

// ============================================================================
// Types
// ============================================================================

/** Raw hook matcher from hooks.json (with optional UI metadata fields) */
interface RawHookMatcher {
  name?: string;
  description?: string;
  matcher?: string;
  cron?: string;
  timezone?: string;
  permissionMode?: 'safe' | 'ask' | 'allow-all';
  labels?: string[];
  enabled?: boolean;
  hooks: Array<{ type: 'prompt'; prompt: string } | { type: 'command'; command: string; timeout?: number }>;
}

/** Scheduled task data returned to the renderer */
export interface ScheduledTaskData {
  index: number;
  name?: string;
  description?: string;
  cron: string;
  timezone?: string;
  enabled: boolean;
  permissionMode?: 'safe' | 'ask' | 'allow-all';
  labels?: string[];
  hooks: Array<{ type: 'prompt'; prompt: string } | { type: 'command'; command: string; timeout?: number }>;
  scheduleDescription: string;
  nextRun: string | null;
}

// ============================================================================
// File I/O Helpers
// ============================================================================

function getHooksPath(workspaceRootPath: string): string {
  return join(workspaceRootPath, 'hooks.json');
}

function readHooksFile(workspaceRootPath: string): { version?: number; hooks: Record<string, RawHookMatcher[]> } {
  const path = getHooksPath(workspaceRootPath);
  if (!existsSync(path)) {
    return { version: 1, hooks: {} };
  }
  const raw = readFileSync(path, 'utf-8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function writeHooksFile(workspaceRootPath: string, data: { version?: number; hooks: Record<string, RawHookMatcher[]> }): void {
  const path = getHooksPath(workspaceRootPath);
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * List all SchedulerTick entries as ScheduledTaskData.
 */
export function listScheduledTasks(workspaceRootPath: string): ScheduledTaskData[] {
  const config = readHooksFile(workspaceRootPath);
  const matchers = config.hooks['SchedulerTick'] || [];

  return matchers
    .filter(m => m.cron) // Only include entries with cron expressions
    .map((m, index) => toTaskData(m, index));
}

/**
 * Create a new SchedulerTick entry.
 */
export function createScheduledTask(
  workspaceRootPath: string,
  task: Omit<ScheduledTaskData, 'index' | 'scheduleDescription' | 'nextRun'>
): ScheduledTaskData {
  // Validate task data
  const errors = validateScheduledTask(task);
  if (errors.length > 0) {
    const errorMsg = errors.map(e => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid scheduled task data: ${errorMsg}`);
  }

  const config = readHooksFile(workspaceRootPath);
  if (!config.hooks['SchedulerTick']) {
    config.hooks['SchedulerTick'] = [];
  }

  const matcher: RawHookMatcher = {
    name: task.name,
    description: task.description,
    cron: task.cron,
    timezone: task.timezone,
    permissionMode: task.permissionMode,
    labels: task.labels,
    enabled: task.enabled,
    hooks: task.hooks,
  };

  // Clean up undefined fields
  if (!matcher.name) delete matcher.name;
  if (!matcher.description) delete matcher.description;
  if (!matcher.timezone) delete matcher.timezone;
  if (!matcher.permissionMode) delete matcher.permissionMode;
  if (!matcher.labels?.length) delete matcher.labels;

  config.hooks['SchedulerTick'].push(matcher);
  if (!config.version) config.version = 1;
  writeHooksFile(workspaceRootPath, config);

  const index = config.hooks['SchedulerTick'].length - 1;
  return toTaskData(matcher, index);
}

/**
 * Update an existing SchedulerTick entry by index.
 */
export function updateScheduledTask(
  workspaceRootPath: string,
  index: number,
  task: Omit<ScheduledTaskData, 'index' | 'scheduleDescription' | 'nextRun'>
): ScheduledTaskData {
  // Validate index
  const indexError = validateTaskIndex(index);
  if (indexError) {
    throw new Error(indexError);
  }

  // Validate task data
  const errors = validateScheduledTask(task);
  if (errors.length > 0) {
    const errorMsg = errors.map(e => `${e.field}: ${e.message}`).join('; ');
    throw new Error(`Invalid scheduled task data: ${errorMsg}`);
  }

  const config = readHooksFile(workspaceRootPath);
  const matchers = config.hooks['SchedulerTick'];
  if (!matchers || index >= matchers.length) {
    throw new Error(`Scheduled task at index ${index} not found`);
  }

  const matcher: RawHookMatcher = {
    name: task.name,
    description: task.description,
    cron: task.cron,
    timezone: task.timezone,
    permissionMode: task.permissionMode,
    labels: task.labels,
    enabled: task.enabled,
    hooks: task.hooks,
  };

  // Clean up undefined fields
  if (!matcher.name) delete matcher.name;
  if (!matcher.description) delete matcher.description;
  if (!matcher.timezone) delete matcher.timezone;
  if (!matcher.permissionMode) delete matcher.permissionMode;
  if (!matcher.labels?.length) delete matcher.labels;

  matchers[index] = matcher;
  writeHooksFile(workspaceRootPath, config);

  return toTaskData(matcher, index);
}

/**
 * Delete a SchedulerTick entry by index.
 */
export function deleteScheduledTask(workspaceRootPath: string, index: number): void {
  // Validate index
  const indexError = validateTaskIndex(index);
  if (indexError) {
    throw new Error(indexError);
  }

  const config = readHooksFile(workspaceRootPath);
  const matchers = config.hooks['SchedulerTick'];
  if (!matchers || index >= matchers.length) {
    throw new Error(`Scheduled task at index ${index} not found`);
  }

  matchers.splice(index, 1);

  // Clean up empty array
  if (matchers.length === 0) {
    delete config.hooks['SchedulerTick'];
  }

  writeHooksFile(workspaceRootPath, config);
}

/**
 * Toggle the enabled state of a SchedulerTick entry.
 */
export function toggleScheduledTask(workspaceRootPath: string, index: number): ScheduledTaskData {
  // Validate index
  const indexError = validateTaskIndex(index);
  if (indexError) {
    throw new Error(indexError);
  }

  const config = readHooksFile(workspaceRootPath);
  const matchers = config.hooks['SchedulerTick'];
  if (!matchers || index >= matchers.length) {
    throw new Error(`Scheduled task at index ${index} not found`);
  }

  const matcher = matchers[index]!;
  matcher.enabled = matcher.enabled === false ? true : false;
  writeHooksFile(workspaceRootPath, config);

  return toTaskData(matcher, index);
}

// ============================================================================
// Helpers
// ============================================================================

function toTaskData(matcher: RawHookMatcher, index: number): ScheduledTaskData {
  return {
    index,
    name: matcher.name,
    description: matcher.description,
    cron: matcher.cron || '',
    timezone: matcher.timezone,
    enabled: matcher.enabled !== false,
    permissionMode: matcher.permissionMode,
    labels: matcher.labels,
    hooks: matcher.hooks,
    scheduleDescription: cronToHuman(matcher.cron || '', matcher.timezone),
    nextRun: getNextRun(matcher.cron || '', matcher.timezone),
  };
}
