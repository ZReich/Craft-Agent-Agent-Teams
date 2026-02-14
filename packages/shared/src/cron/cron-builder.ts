/**
 * Cron Builder Utilities
 *
 * Provides functions to parse and build cron expressions from UI-friendly formats.
 * Supports daily, weekly, monthly, and custom schedules.
 *
 * Cron format: `minute hour day-of-month month day-of-week`
 * - minute: 0-59
 * - hour: 0-23
 * - day-of-month (dom): 1-31
 * - month: 1-12 or *
 * - day-of-week (dow): 0-6 (0=Sunday) or *
 */

export type SchedulePreset = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

export const DAYS_OF_WEEK = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
] as const;

/**
 * Detect which preset a cron expression matches (daily/weekly/monthly/custom).
 *
 * @param cron - Cron expression (5 fields: min hour dom month dow)
 * @returns Detected preset type
 */
export function detectPreset(cron: string): SchedulePreset {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'custom';

  const min = parts[0];
  const hour = parts[1];
  const dom = parts[2]; // day-of-month
  const month = parts[3];
  const dow = parts[4]; // day-of-week

  // Hourly: runs every hour at specific minute (hour=*, dom=*, month=*, dow=*)
  if (min && min.match(/^\d+$/) && hour === '*' && dom === '*' && month === '*' && dow === '*') return 'hourly';

  // Validate time fields are numeric
  if (!min || !min.match(/^\d+$/) || !hour || !hour.match(/^\d+$/)) {
    return 'custom';
  }

  // Daily: runs every day at specific time (dom=*, month=*, dow=*)
  if (dom === '*' && month === '*' && dow === '*') return 'daily';

  // Weekly: runs on specific days of week (dom=*, month=*, dow=specific)
  if (dom === '*' && month === '*' && dow && dow !== '*') return 'weekly';

  // Monthly: runs on specific day of month (dom=specific, month=*, dow=*)
  if (dom && dom.match(/^\d+$/) && month === '*' && dow === '*') return 'monthly';

  return 'custom';
}

/**
 * Parse hour and minute from a cron expression.
 *
 * @param cron - Cron expression
 * @returns Object with hour (0-23) and minute (0-59)
 */
export function parseCronTime(cron: string): { hour: number; minute: number } {
  const parts = cron.trim().split(/\s+/);
  const minuteStr = parts[0] || '0';
  const hourStr = parts[1] || '9';

  // Use parseInt with radix 10 to avoid octal parsing issues
  const minute = parseInt(minuteStr, 10);
  const hour = parseInt(hourStr, 10);

  return {
    minute: isNaN(minute) ? 0 : minute,
    hour: isNaN(hour) ? 0 : hour,
  };
}

/**
 * Parse selected days from a weekly cron expression.
 *
 * Handles comma-separated days (1,3,5) and ranges (1-5).
 *
 * @param cron - Cron expression
 * @returns Array of day numbers (0=Sunday, 6=Saturday)
 */
export function parseCronDays(cron: string): number[] {
  const parts = cron.trim().split(/\s+/);
  const dow = parts[4] || '*';

  // Default to weekdays if wildcard
  if (dow === '*') return [1, 2, 3, 4, 5];

  const days: number[] = [];
  const segments = dow.split(',');

  for (const part of segments) {
    // Check for range pattern (e.g., "1-5")
    const rangeMatch = part.match(/^(\d)-(\d)$/);
    if (rangeMatch && rangeMatch[1] && rangeMatch[2]) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = start; i <= end; i++) {
          days.push(i);
        }
      }
    } else {
      // Single day number
      const n = parseInt(part, 10);
      if (!isNaN(n)) {
        days.push(n);
      }
    }
  }

  return days;
}

/**
 * Parse day of month from a monthly cron expression.
 *
 * @param cron - Cron expression
 * @returns Day of month (1-31), defaults to 1 if invalid
 */
export function parseCronDayOfMonth(cron: string): number {
  const parts = cron.trim().split(/\s+/);
  const dom = parts[2] || '1';
  const parsed = parseInt(dom, 10);
  return isNaN(parsed) ? 1 : parsed;
}

/**
 * Build a cron expression from UI parameters.
 *
 * @param preset - Schedule type (daily/weekly/monthly/custom)
 * @param hour - Hour (0-23)
 * @param minute - Minute (0-59)
 * @param days - Days of week for weekly schedule (0=Sunday)
 * @param dayOfMonth - Day of month for monthly schedule (1-31)
 * @param customCron - Custom cron string (used when preset='custom')
 * @returns Cron expression string
 */
export function buildCron(
  preset: SchedulePreset,
  hour: number,
  minute: number,
  days: number[],
  dayOfMonth: number,
  customCron: string
): string {
  switch (preset) {
    case 'hourly':
      return `${minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly': {
      const dowStr = days.length === 0 ? '1-5' : days.sort((a, b) => a - b).join(',');
      return `${minute} ${hour} * * ${dowStr}`;
    }
    case 'monthly':
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case 'custom':
      return customCron;
  }
}

/**
 * Validate a cron expression has the correct number of fields.
 *
 * @param cron - Cron expression to validate
 * @returns true if valid (5 fields), false otherwise
 */
export function isValidCronFormat(cron: string): boolean {
  const parts = cron.trim().split(/\s+/);
  return parts.length === 5;
}
