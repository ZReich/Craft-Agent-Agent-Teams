/**
 * Tests for UsageAlertChecker class
 *
 * These tests verify that usage alerts are correctly generated based on
 * configurable thresholds for session calls, weekly spend, and cost caps.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { UsageAlertChecker } from '../usage-alerts.ts';
import type {
  SessionUsage,
  WeeklyUsageSummary,
  UsageAlertThresholds,
} from '@craft-agent/core';

// Helper to create mock session usage
function createMockSession(overrides: Partial<SessionUsage> = {}): SessionUsage {
  return {
    sessionId: 'test-session',
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    weekIdentifier: '2026-W06',
    providers: {
      anthropic: {
        callCount: 5,
        inputTokens: 1000,
        outputTokens: 500,
        estimatedCostUsd: 0.15,
      },
      openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
      openrouter: {
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      },
    },
    totalCalls: 5,
    totalDurationMs: 3600000,
    ...overrides,
  };
}

// Helper to create mock weekly usage
function createMockWeekly(overrides: Partial<WeeklyUsageSummary> = {}): WeeklyUsageSummary {
  return {
    weekIdentifier: '2026-W06',
    startDate: '2026-02-02T00:00:00.000Z',
    endDate: '2026-02-08T23:59:59.999Z',
    sessionCount: 1,
    totals: {
      calls: 5,
      inputTokens: 1000,
      outputTokens: 500,
      estimatedCostUsd: 0.15,
      durationMs: 3600000,
    },
    providerBreakdown: {},
    dailyBreakdown: [],
    sessions: [],
    ...overrides,
  };
}

describe('UsageAlertChecker', () => {
  let checker: UsageAlertChecker;

  beforeEach(() => {
    checker = new UsageAlertChecker();
  });

  describe('constructor and default thresholds', () => {
    test('should use default thresholds when none provided', () => {
      const thresholds = checker.getThresholds();

      expect(thresholds.weeklySpendWarningUsd).toBe(10.0);
      expect(thresholds.sessionCallsWarning).toBe(100);
      expect(thresholds.costCapUsd).toBeUndefined();
    });

    test('should allow custom thresholds in constructor', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 20.0,
        sessionCallsWarning: 200,
      });

      const thresholds = customChecker.getThresholds();
      expect(thresholds.weeklySpendWarningUsd).toBe(20.0);
      expect(thresholds.sessionCallsWarning).toBe(200);
    });

    test('should merge partial thresholds with defaults', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 15.0,
      });

      const thresholds = customChecker.getThresholds();
      expect(thresholds.weeklySpendWarningUsd).toBe(15.0);
      expect(thresholds.sessionCallsWarning).toBe(100); // default
    });
  });

  describe('updateThresholds', () => {
    test('should update thresholds', () => {
      checker.updateThresholds({ weeklySpendWarningUsd: 25.0 });

      const thresholds = checker.getThresholds();
      expect(thresholds.weeklySpendWarningUsd).toBe(25.0);
    });

    test('should preserve other thresholds when updating', () => {
      checker.updateThresholds({ sessionCallsWarning: 150 });

      const thresholds = checker.getThresholds();
      expect(thresholds.sessionCallsWarning).toBe(150);
      expect(thresholds.weeklySpendWarningUsd).toBe(10.0); // default preserved
    });

    test('should allow setting cost cap', () => {
      checker.updateThresholds({ costCapUsd: 50.0 });

      const thresholds = checker.getThresholds();
      expect(thresholds.costCapUsd).toBe(50.0);
    });

    test('should update multiple thresholds at once', () => {
      checker.updateThresholds({
        weeklySpendWarningUsd: 15.0,
        sessionCallsWarning: 200,
        costCapUsd: 100.0,
      });

      const thresholds = checker.getThresholds();
      expect(thresholds.weeklySpendWarningUsd).toBe(15.0);
      expect(thresholds.sessionCallsWarning).toBe(200);
      expect(thresholds.costCapUsd).toBe(100.0);
    });
  });

  describe('getThresholds', () => {
    test('should return a copy of thresholds', () => {
      const thresholds1 = checker.getThresholds();
      const thresholds2 = checker.getThresholds();

      expect(thresholds1).not.toBe(thresholds2); // Different objects
      expect(thresholds1).toEqual(thresholds2); // Same values
    });

    test('should not allow external modification of thresholds', () => {
      const thresholds = checker.getThresholds();
      thresholds.weeklySpendWarningUsd = 999.0;

      const actualThresholds = checker.getThresholds();
      expect(actualThresholds.weeklySpendWarningUsd).toBe(10.0);
    });
  });

  describe('checkAlerts - no alerts when within thresholds', () => {
    test('should return no alerts when everything is within limits', () => {
      const session = createMockSession({
        totalCalls: 50, // Below 100
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 50,
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCostUsd: 5.0, // Below 10.0
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });

    test('should return no alerts for zero usage', () => {
      const session = createMockSession({
        totalCalls: 0,
        providers: {
          anthropic: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openai: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      moonshot: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
          openrouter: { callCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        },
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
          durationMs: 0,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });

    test('should return no alerts when exactly at threshold (not over)', () => {
      const session = createMockSession({
        totalCalls: 100, // Exactly at threshold
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCostUsd: 10.0, // Exactly at threshold
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });
  });

  describe('checkAlerts - weekly spend warning', () => {
    test('should trigger warning when weekly spend exceeds threshold', () => {
      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 15.0, // Above 10.0 threshold
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.type).toBe('warning');
      expect(alerts[0]!.message).toContain('Weekly spend');
      expect(alerts[0]!.message).toContain('$15.00');
      expect(alerts[0]!.message).toContain('$10.00');
    });

    test('should include formatted cost values in warning message', () => {
      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 12.567, // Should be formatted to 2 decimals
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts[0]!.message).toContain('$12.57');
    });

    test('should include context data in warning', () => {
      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 15.0,
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts[0]!.context).toBeDefined();
      expect(alerts[0]!.context?.spend).toBe(15.0);
      expect(alerts[0]!.context?.threshold).toBe(10.0);
    });

    test('should respect custom weekly spend threshold', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 20.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 15.0, // Below new threshold
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });
  });

  describe('checkAlerts - session calls warning', () => {
    test('should trigger info alert when session calls exceed threshold', () => {
      const session = createMockSession({
        totalCalls: 150, // Above 100 threshold
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 1000,
          outputTokens: 500,
          estimatedCostUsd: 5.0,
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.type).toBe('info');
      expect(alerts[0]!.message).toContain('High API usage');
      expect(alerts[0]!.message).toContain('150 calls');
    });

    test('should include call count in context', () => {
      const session = createMockSession({
        totalCalls: 150,
      });

      const weekly = createMockWeekly();

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts[0]!.context).toBeDefined();
      expect(alerts[0]!.context?.calls).toBe(150);
    });

    test('should respect custom session calls threshold', () => {
      const customChecker = new UsageAlertChecker({
        sessionCallsWarning: 200,
      });

      const session = createMockSession({
        totalCalls: 150, // Below new threshold
      });

      const weekly = createMockWeekly();

      const alerts = customChecker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });

    test('should trigger for very high call counts', () => {
      const session = createMockSession({
        totalCalls: 1000,
      });

      const weekly = createMockWeekly();

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts.some(a => a.type === 'info')).toBe(true);
      expect(alerts.some(a => a.message.includes('1000 calls'))).toBe(true);
    });
  });

  describe('checkAlerts - cost cap error', () => {
    test('should trigger error when cost cap is reached', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 20.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 20.0, // At cap
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      const errorAlert = alerts.find(a => a.type === 'error');
      expect(errorAlert).toBeDefined();
      expect(errorAlert?.message).toContain('Cost cap reached');
      expect(errorAlert?.message).toContain('$20.00');
    });

    test('should trigger error when cost cap is exceeded', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 20.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 25.0, // Over cap
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      const errorAlert = alerts.find(a => a.type === 'error');
      expect(errorAlert).toBeDefined();
      expect(errorAlert?.message).toContain('Cost cap reached');
    });

    test('should not trigger error when no cost cap is set', () => {
      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 100.0, // Very high, but no cap
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      const errorAlert = alerts.find(a => a.type === 'error');
      expect(errorAlert).toBeUndefined();
    });

    test('should include context in cost cap error', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 20.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 25.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);
      const errorAlert = alerts.find(a => a.type === 'error');

      expect(errorAlert?.context).toBeDefined();
      expect(errorAlert?.context?.spend).toBe(25.0);
      expect(errorAlert?.context?.cap).toBe(20.0);
    });

    test('should format cost values to 2 decimal places', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 20.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 25.456,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);
      const errorAlert = alerts.find(a => a.type === 'error');

      expect(errorAlert?.message).toContain('$25.46');
    });
  });

  describe('checkAlerts - multiple alerts', () => {
    test('should fire multiple alerts simultaneously', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 10.0,
        sessionCallsWarning: 100,
        costCapUsd: 30.0,
      });

      const session = createMockSession({
        totalCalls: 150, // Above calls threshold
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 35.0, // Above warning and cap
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      expect(alerts.length).toBeGreaterThanOrEqual(3);
      expect(alerts.some(a => a.type === 'warning')).toBe(true); // Weekly spend
      expect(alerts.some(a => a.type === 'info')).toBe(true); // Session calls
      expect(alerts.some(a => a.type === 'error')).toBe(true); // Cost cap
    });

    test('should include timestamps in all alerts', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 10.0,
        sessionCallsWarning: 100,
        costCapUsd: 30.0,
      });

      const session = createMockSession({
        totalCalls: 150,
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 35.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      for (const alert of alerts) {
        expect(alert.timestamp).toBeDefined();
        expect(new Date(alert.timestamp).toISOString()).toBe(alert.timestamp);
      }
    });

    test('should return alerts in consistent order', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 10.0,
        sessionCallsWarning: 100,
        costCapUsd: 30.0,
      });

      const session = createMockSession({
        totalCalls: 150,
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 35.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      // Order should be: weekly spend warning, session calls info, cost cap error
      expect(alerts[0]!.type).toBe('warning'); // Weekly spend
      expect(alerts[1]!.type).toBe('info'); // Session calls
      expect(alerts[2]!.type).toBe('error'); // Cost cap
    });
  });

  describe('checkAlerts - alert message formatting', () => {
    test('should contain clear, readable messages', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 20.0,
      });

      const session = createMockSession({
        totalCalls: 150,
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 25.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      for (const alert of alerts) {
        expect(alert.message).toBeTruthy();
        expect(alert.message.length).toBeGreaterThan(10);
        expect(typeof alert.message).toBe('string');
      }
    });

    test('should include relevant numeric values in messages', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 10.0,
        sessionCallsWarning: 100,
      });

      const session = createMockSession({
        totalCalls: 150,
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 150,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 15.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      const spendAlert = alerts.find(a => a.message.includes('Weekly spend'));
      const callsAlert = alerts.find(a => a.message.includes('High API usage'));

      expect(spendAlert?.message).toContain('15.00');
      expect(callsAlert?.message).toContain('150');
    });
  });

  describe('checkAlerts - edge cases', () => {
    test('should handle very small costs correctly', () => {
      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 5,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: 0.001,
          durationMs: 1000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);
      expect(alerts).toHaveLength(0);
    });

    test('should handle very large costs correctly', () => {
      const customChecker = new UsageAlertChecker({
        weeklySpendWarningUsd: 100.0,
        costCapUsd: 1000.0,
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 10000,
          inputTokens: 1000000,
          outputTokens: 500000,
          estimatedCostUsd: 500.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      // Should trigger weekly warning but not cost cap
      expect(alerts.some(a => a.type === 'warning')).toBe(true);
      expect(alerts.some(a => a.type === 'error')).toBe(false);
    });

    test('should handle zero cost cap as falsy (no cap)', () => {
      const customChecker = new UsageAlertChecker({
        costCapUsd: 0, // Should be treated as no cap
      });

      const session = createMockSession();
      const weekly = createMockWeekly({
        totals: {
          calls: 100,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 25.0,
          durationMs: 3600000,
        },
      });

      const alerts = customChecker.checkAlerts(session, weekly);

      // Should not trigger cost cap error for 0 cap
      expect(alerts.some(a => a.type === 'error')).toBe(false);
    });

    test('should handle costs at exact threshold boundary', () => {
      const session = createMockSession({
        totalCalls: 101, // Just over threshold
      });

      const weekly = createMockWeekly({
        totals: {
          calls: 101,
          inputTokens: 5000,
          outputTokens: 2500,
          estimatedCostUsd: 10.01, // Just over threshold
          durationMs: 3600000,
        },
      });

      const alerts = checker.checkAlerts(session, weekly);

      expect(alerts.length).toBe(2); // Both should trigger
    });
  });
});
