/**
 * Usage Tracking types for session-level and weekly usage aggregation
 *
 * These types define the data model for tracking token usage, API calls,
 * and costs across sessions and weekly periods.
 */

// ============================================================
// Session-Level Usage
// ============================================================

/**
 * Session-level usage tracking (persisted to disk)
 */
export interface SessionUsage {
  sessionId: string;
  startedAt: string; // ISO8601
  lastUpdatedAt: string; // ISO8601
  weekIdentifier: string; // "2026-W06"

  // Token totals by provider
  providers: {
    anthropic: ProviderUsage;
    openai: ProviderUsage;
    moonshot: ProviderUsage;
    openrouter: ProviderUsage;
  };

  totalCalls: number;
  totalDurationMs: number;

  // Agent teams data (if teams were used)
  teamUsage?: TeamSessionUsage;
}

/**
 * Usage data for a specific provider
 */
export interface ProviderUsage {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number; // 0 for subscription providers
}

/**
 * Team-specific usage within a session
 */
export interface TeamSessionUsage {
  teamId: string;
  teammateCount: number;
  totalTeamCostUsd: number;
  perTeammate: Record<string, {
    name: string;
    model: string;
    provider: string;
    role: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    callCount: number;
  }>;
  perModel: Record<string, {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    callCount: number;
  }>;
}

// ============================================================
// Weekly Aggregation
// ============================================================

/**
 * Weekly aggregated usage summary
 */
export interface WeeklyUsageSummary {
  weekIdentifier: string;
  startDate: string;
  endDate: string;
  sessionCount: number;
  totals: {
    calls: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
    durationMs: number;
  };
  providerBreakdown: Record<string, ProviderUsage>;
  teamUsage?: {
    teamsCreated: number;
    teammatesSpawned: number;
    totalTeamCostUsd: number;
  };
  dailyBreakdown: DailyUsage[];
  sessions: SessionUsageRef[];
}

/**
 * Daily usage data point within a week
 */
export interface DailyUsage {
  date: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
}

/**
 * Reference to a completed session within weekly summary
 */
export interface SessionUsageRef {
  sessionId: string;
  startedAt: string;
  endedAt: string;
  calls: number;
  tokens: number;
  estimatedCostUsd: number;
  primaryModel: string;
  hadTeams: boolean;
}

// ============================================================
// Alert Thresholds
// ============================================================

/**
 * Configurable usage alert thresholds
 */
export interface UsageAlertThresholds {
  weeklySpendWarningUsd: number;   // Default: 10.00
  sessionCallsWarning: number;      // Default: 100
  costCapUsd?: number;              // Optional hard cap
}

/**
 * A usage alert notification
 */
export interface UsageAlert {
  type: 'error' | 'warning' | 'info';
  message: string;
  timestamp: string;
  context?: Record<string, unknown>;
}
