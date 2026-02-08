/**
 * Usage Alert Checker
 *
 * Evaluates session and weekly usage against configurable thresholds
 * and generates alerts for warnings and errors.
 */

import type {
  SessionUsage,
  WeeklyUsageSummary,
  UsageAlertThresholds,
  UsageAlert,
} from '@craft-agent/core';

const DEFAULT_THRESHOLDS: UsageAlertThresholds = {
  weeklySpendWarningUsd: 10.00,
  sessionCallsWarning: 100,
};

export class UsageAlertChecker {
  private thresholds: UsageAlertThresholds;

  constructor(thresholds?: Partial<UsageAlertThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /** Update alert thresholds */
  updateThresholds(thresholds: Partial<UsageAlertThresholds>): void {
    Object.assign(this.thresholds, thresholds);
  }

  /** Get current thresholds */
  getThresholds(): UsageAlertThresholds {
    return { ...this.thresholds };
  }

  /** Check for alerts based on session and weekly usage */
  checkAlerts(session: SessionUsage, weekly: WeeklyUsageSummary): UsageAlert[] {
    const alerts: UsageAlert[] = [];
    const now = new Date().toISOString();

    // Weekly spend warning
    if (weekly.totals.estimatedCostUsd > this.thresholds.weeklySpendWarningUsd) {
      alerts.push({
        type: 'warning',
        message: `Weekly spend at $${weekly.totals.estimatedCostUsd.toFixed(2)} (threshold: $${this.thresholds.weeklySpendWarningUsd.toFixed(2)})`,
        timestamp: now,
        context: {
          spend: weekly.totals.estimatedCostUsd,
          threshold: this.thresholds.weeklySpendWarningUsd,
        },
      });
    }

    // Session calls warning
    if (session.totalCalls > this.thresholds.sessionCallsWarning) {
      alerts.push({
        type: 'info',
        message: `High API usage: ${session.totalCalls} calls this session`,
        timestamp: now,
        context: { calls: session.totalCalls },
      });
    }

    // Cost cap
    if (this.thresholds.costCapUsd && weekly.totals.estimatedCostUsd >= this.thresholds.costCapUsd) {
      alerts.push({
        type: 'error',
        message: `Cost cap reached: $${weekly.totals.estimatedCostUsd.toFixed(2)} / $${this.thresholds.costCapUsd.toFixed(2)}`,
        timestamp: now,
        context: {
          spend: weekly.totals.estimatedCostUsd,
          cap: this.thresholds.costCapUsd,
        },
      });
    }

    return alerts;
  }
}
