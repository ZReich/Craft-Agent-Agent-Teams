/**
 * Cron Utilities for Scheduled Tasks
 *
 * Converts cron expressions to human-readable descriptions
 * and calculates next run times using the croner library.
 */

import { Cron } from 'croner';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Convert a cron expression to a human-readable description.
 *
 * @param cronExpr - 5-field cron expression
 * @param timezone - Optional IANA timezone
 * @returns Human-readable description like "Weekdays at 9:00 AM"
 */
export function cronToHuman(cronExpr: string, timezone?: string): string {
  try {
    const parts = cronExpr.trim().split(/\s+/);
    if (parts.length !== 5) return cronExpr;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    // Every minute
    if (cronExpr === '* * * * *') return 'Every minute';

    // Every N minutes
    const everyMinMatch = minute!.match(/^\*\/(\d+)$/);
    if (everyMinMatch && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const n = parseInt(everyMinMatch[1]!);
      return n === 1 ? 'Every minute' : `Every ${n} minutes`;
    }

    // Every N hours
    const everyHourMatch = hour!.match(/^\*\/(\d+)$/);
    if (minute === '0' && everyHourMatch && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const n = parseInt(everyHourMatch[1]!);
      return n === 1 ? 'Every hour' : `Every ${n} hours`;
    }

    // Hourly at specific minute
    if (minute!.match(/^\d+$/) && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
      const m = parseInt(minute!);
      return m === 0 ? 'Every hour' : `Every hour at :${m.toString().padStart(2, '0')}`;
    }

    // Specific time patterns
    if (minute!.match(/^\d+$/) && hour!.match(/^\d+$/)) {
      const timeStr = formatTime(parseInt(hour!), parseInt(minute!));
      const tzSuffix = timezone ? ` ${getShortTz(timezone)}` : '';

      // Daily
      if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
        return `Daily at ${timeStr}${tzSuffix}`;
      }

      // Weekdays (1-5 or Mon-Fri)
      if (dayOfMonth === '*' && month === '*' && (dayOfWeek === '1-5')) {
        return `Weekdays at ${timeStr}${tzSuffix}`;
      }

      // Weekends
      if (dayOfMonth === '*' && month === '*' && (dayOfWeek === '0,6' || dayOfWeek === '6,0')) {
        return `Weekends at ${timeStr}${tzSuffix}`;
      }

      // Specific days of week
      if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
        const dayNames = parseDayOfWeek(dayOfWeek!);
        if (dayNames.length === 1) {
          return `${dayNames[0]}s at ${timeStr}${tzSuffix}`;
        }
        return `${dayNames.join(', ')} at ${timeStr}${tzSuffix}`;
      }

      // Monthly (specific day of month)
      if (dayOfMonth!.match(/^\d+$/) && month === '*' && dayOfWeek === '*') {
        const dom = parseInt(dayOfMonth!);
        return `Monthly on the ${ordinal(dom)} at ${timeStr}${tzSuffix}`;
      }

      // Yearly (specific month and day)
      if (dayOfMonth!.match(/^\d+$/) && month!.match(/^\d+$/) && dayOfWeek === '*') {
        const dom = parseInt(dayOfMonth!);
        const mon = parseInt(month!);
        const monthName = getMonthName(mon);
        return `${monthName} ${ordinal(dom)} at ${timeStr}${tzSuffix}`;
      }
    }

    // Fallback: use the raw expression
    return cronExpr;
  } catch {
    return cronExpr;
  }
}

/**
 * Calculate the next run time for a cron expression.
 *
 * @param cronExpr - 5-field cron expression
 * @param timezone - Optional IANA timezone
 * @returns ISO 8601 timestamp of next run, or null if invalid
 */
export function getNextRun(cronExpr: string, timezone?: string): string | null {
  try {
    const options = timezone ? { timezone } : {};
    const job = new Cron(cronExpr, options);
    const next = job.nextRun();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatTime(hour: number, minute: number): string {
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  const m = minute.toString().padStart(2, '0');
  return `${h}:${m} ${ampm}`;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0])!;
}

function parseDayOfWeek(field: string): string[] {
  const days: string[] = [];
  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!);
      const end = parseInt(rangeMatch[2]!);
      for (let i = start; i <= end; i++) {
        if (SHORT_DAYS[i]) days.push(SHORT_DAYS[i]!);
      }
    } else {
      const num = parseInt(part);
      if (!isNaN(num) && SHORT_DAYS[num]) {
        days.push(SHORT_DAYS[num]!);
      }
    }
  }
  return days;
}

function getMonthName(month: number): string {
  const months = ['', 'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return months[month] || `Month ${month}`;
}

function getShortTz(timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'short',
    });
    const parts = formatter.formatToParts(new Date());
    const tzPart = parts.find(p => p.type === 'timeZoneName');
    return tzPart?.value || '';
  } catch {
    return '';
  }
}
