/**
 * Validation utilities for scheduled tasks
 */

import { isValidCronFormat } from '../cron/index.js';
import type { ScheduledTaskData } from './storage.js';

export interface ValidationError {
  field: string;
  message: string;
}

/**
 * Validate a scheduled task object before persisting.
 *
 * @param task - Task data to validate
 * @returns Array of validation errors (empty if valid)
 */
export function validateScheduledTask(
  task: Omit<ScheduledTaskData, 'index' | 'scheduleDescription' | 'nextRun'>
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Validate cron expression
  if (!task.cron || typeof task.cron !== 'string') {
    errors.push({ field: 'cron', message: 'Cron expression is required' });
  } else if (!isValidCronFormat(task.cron)) {
    errors.push({ field: 'cron', message: 'Invalid cron format (expected 5 fields: min hour dom month dow)' });
  }

  // Validate hooks array
  if (!task.hooks || !Array.isArray(task.hooks)) {
    errors.push({ field: 'hooks', message: 'Hooks array is required' });
  } else if (task.hooks.length === 0) {
    errors.push({ field: 'hooks', message: 'At least one hook is required' });
  } else {
    // Validate each hook
    task.hooks.forEach((hook, idx) => {
      if (!hook || typeof hook !== 'object') {
        errors.push({ field: `hooks[${idx}]`, message: 'Hook must be an object' });
        return;
      }

      if (hook.type === 'prompt') {
        if (!hook.prompt || typeof hook.prompt !== 'string' || hook.prompt.trim().length === 0) {
          errors.push({ field: `hooks[${idx}].prompt`, message: 'Prompt hook requires non-empty prompt field' });
        }
      } else if (hook.type === 'command') {
        if (!hook.command || typeof hook.command !== 'string' || hook.command.trim().length === 0) {
          errors.push({ field: `hooks[${idx}].command`, message: 'Command hook requires non-empty command field' });
        }
      } else {
        errors.push({ field: `hooks[${idx}].type`, message: `Unknown hook type: ${(hook as any).type}` });
      }
    });
  }

  // Validate name if provided
  if (task.name !== undefined && typeof task.name !== 'string') {
    errors.push({ field: 'name', message: 'Name must be a string' });
  }

  // Validate timezone if provided
  if (task.timezone !== undefined && typeof task.timezone !== 'string') {
    errors.push({ field: 'timezone', message: 'Timezone must be a string' });
  }

  // Validate enabled if provided
  if (task.enabled !== undefined && typeof task.enabled !== 'boolean') {
    errors.push({ field: 'enabled', message: 'Enabled must be a boolean' });
  }

  return errors;
}

/**
 * Validate an index parameter for scheduled task operations.
 *
 * @param index - Index to validate
 * @param arrayLength - Optional length of the array to validate bounds
 * @returns Error message if invalid, null if valid
 */
export function validateTaskIndex(index: number, arrayLength?: number): string | null {
  if (!Number.isInteger(index)) {
    return 'Index must be an integer';
  }

  if (index < 0) {
    return 'Index must be non-negative';
  }

  if (arrayLength !== undefined && index >= arrayLength) {
    return `Index ${index} out of bounds (array length: ${arrayLength})`;
  }

  return null;
}
