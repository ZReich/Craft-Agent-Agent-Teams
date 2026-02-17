import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { KnowledgeTelemetryEvent, QualityGateConfig, QualityGateResult } from '@craft-agent/core/types';

const LEARNING_FILE = 'agent-team-learning.json';
const MAX_QUALITY_EVENTS = 300;
const MAX_KNOWLEDGE_EVENTS = 2_000;
export const LEARNING_RETENTION_DAYS = 30;
const LEARNING_RETENTION_MS = LEARNING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const ADOPTION_WINDOW_DAYS = 7;
const ADOPTION_WINDOW_MS = ADOPTION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

interface QualityLearningEvent {
  timestamp: string;
  passed: boolean;
  aggregateScore: number;
  cycleCount: number;
  escalated: boolean;
  architectureScore: number;
  simplicityScore: number;
  errorsScore: number;
  completenessScore: number;
}

interface PersistedKnowledgeTelemetryEvent extends KnowledgeTelemetryEvent {
  timestamp: string;
}

interface LearningStoreData {
  version: 1;
  qualityEvents: QualityLearningEvent[];
  knowledgeEvents: PersistedKnowledgeTelemetryEvent[];
}

export interface LearningGuidance {
  preferManaged: boolean;
  tightenErrorBypass: boolean;
  rationale: string[];
}

export interface AdoptionOutcomeWindow {
  start: string;
  end: string;
  runs: number;
  passRate: number;
  retryRate: number;
  escalationRate: number;
  avgScore: number;
  queryCount: number;
  injectionCount: number;
  injectionHitRate: number | null;
}

export interface AdoptionOutcomeSummary {
  baseline: AdoptionOutcomeWindow;
  current: AdoptionOutcomeWindow;
  deltas: {
    retryRate: number;
    escalationRate: number;
    passRate: number;
    queryCount: number;
    injectionHitRate: number | null;
  };
  thresholds: {
    minRunsPerWindow: number;
    minQueryEvents: number;
    minInjectionHitRate: number;
    maxRetryRateIncrease: number;
    maxEscalationRateIncrease: number;
    minPassRate: number;
  };
  success: boolean;
}

function getLearningFilePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, '.craft-agent', LEARNING_FILE);
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}

function loadStore(workspaceRootPath: string): LearningStoreData {
  const filePath = getLearningFilePath(workspaceRootPath);
  if (!existsSync(filePath)) {
    return { version: 1, qualityEvents: [], knowledgeEvents: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<LearningStoreData>;
    const retentionStart = Date.now() - LEARNING_RETENTION_MS;
    const rawQualityEvents = Array.isArray(parsed.qualityEvents) ? parsed.qualityEvents : [];
    const qualityEvents = rawQualityEvents
      .filter((event): event is QualityLearningEvent =>
        Boolean(event && typeof event.aggregateScore === 'number' && typeof event.cycleCount === 'number'),
      )
      .map((event) => ({
        ...event,
        escalated: Boolean(event.escalated),
      }))
      .filter((event) => {
        const timestampMs = parseTimestampMs(event.timestamp);
        return timestampMs == null || timestampMs >= retentionStart;
      })
      .slice(-MAX_QUALITY_EVENTS);

    const rawKnowledgeEvents = Array.isArray(parsed.knowledgeEvents) ? parsed.knowledgeEvents : [];
    const knowledgeEvents = rawKnowledgeEvents
      .filter((event): event is PersistedKnowledgeTelemetryEvent =>
        Boolean(
          event
          && (event.operation === 'inject' || event.operation === 'query')
          && typeof event.resultCount === 'number'
          && typeof event.hit === 'boolean'
          && typeof event.scope === 'string',
        ),
      )
      .map((event) => ({ ...event, channel: 'knowledge' as const }))
      .filter((event) => {
        const timestampMs = parseTimestampMs(event.timestamp);
        return timestampMs == null || timestampMs >= retentionStart;
      })
      .slice(-MAX_KNOWLEDGE_EVENTS);

    return {
      version: 1,
      qualityEvents,
      knowledgeEvents,
    };
  } catch {
    return { version: 1, qualityEvents: [], knowledgeEvents: [] };
  }
}

function persistStore(workspaceRootPath: string, data: LearningStoreData): void {
  const filePath = getLearningFilePath(workspaceRootPath);
  const dirPath = dirname(filePath);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function tightenMax(value: number | undefined, defaultValue: number, maxValue: number): number {
  return Math.min(value ?? defaultValue, maxValue);
}

function tightenMin(value: number | undefined, defaultValue: number, minValue: number): number {
  return Math.max(value ?? defaultValue, minValue);
}

function applyTightenedConstraints(config: QualityGateConfig): NonNullable<QualityGateConfig['bypass']> {
  return {
    enabled: config.bypass?.enabled ?? true,
    architecture: {
      maxDiffLines: tightenMax(config.bypass?.architecture?.maxDiffLines, 50, 30),
      maxFilesChanged: tightenMax(config.bypass?.architecture?.maxFilesChanged, 2, 1),
      allowNewFiles: false,
      defaultScore: tightenMin(config.bypass?.architecture?.defaultScore, 90, 92),
    },
    simplicity: {
      maxDiffLines: tightenMax(config.bypass?.simplicity?.maxDiffLines, 100, 60),
      maxFunctionLines: tightenMax(config.bypass?.simplicity?.maxFunctionLines, 50, 35),
      defaultScore: tightenMin(config.bypass?.simplicity?.defaultScore, 90, 92),
    },
    errors: {
      maxDiffLines: tightenMax(config.bypass?.errors?.maxDiffLines, 50, 30),
      requirePassingTests: true,
      minTestCount: tightenMin(config.bypass?.errors?.minTestCount, 1, 2),
      disallowAsyncAwait: true,
      defaultScore: tightenMin(config.bypass?.errors?.defaultScore, 90, 92),
    },
  };
}

/**
 * Implements REQ-NEXT-006: persist review outcomes across sessions.
 */
export function recordQualityLearning(
  workspaceRootPath: string,
  result: QualityGateResult,
): void {
  if (!workspaceRootPath) return;
  const store = loadStore(workspaceRootPath);
  store.qualityEvents.push({
    timestamp: new Date().toISOString(),
    passed: result.passed,
    aggregateScore: result.aggregateScore,
    cycleCount: result.cycleCount,
    escalated: Boolean(result.escalatedTo),
    architectureScore: result.stages.architecture?.score ?? 100,
    simplicityScore: result.stages.simplicity?.score ?? 100,
    errorsScore: result.stages.errors?.score ?? 100,
    completenessScore: result.stages.completeness?.score ?? 100,
  });
  if (store.qualityEvents.length > MAX_QUALITY_EVENTS) {
    store.qualityEvents.splice(0, store.qualityEvents.length - MAX_QUALITY_EVENTS);
  }
  persistStore(workspaceRootPath, store);
}

/**
 * Record structured knowledge telemetry for query/injection paths.
 * Implements REQ-002 + REQ-010 usage tracking foundation.
 */
export function recordKnowledgeTelemetry(
  workspaceRootPath: string,
  event: Omit<PersistedKnowledgeTelemetryEvent, 'timestamp' | 'channel'>,
): void {
  if (!workspaceRootPath) return;
  const store = loadStore(workspaceRootPath);
  store.knowledgeEvents.push({
    ...event,
    channel: 'knowledge',
    timestamp: new Date().toISOString(),
  });
  if (store.knowledgeEvents.length > MAX_KNOWLEDGE_EVENTS) {
    store.knowledgeEvents.splice(0, store.knowledgeEvents.length - MAX_KNOWLEDGE_EVENTS);
  }
  persistStore(workspaceRootPath, store);
}

/**
 * Implements REQ-NEXT-006: use historical quality outcomes to influence runtime decisions.
 */
export function getLearningGuidance(workspaceRootPath: string): LearningGuidance {
  const store = loadStore(workspaceRootPath);
  const events = store.qualityEvents;
  if (events.length < 6) {
    return {
      preferManaged: false,
      tightenErrorBypass: false,
      rationale: ['Insufficient learning history (<6 quality events).'],
    };
  }

  const recent = events.slice(-40);
  const failed = recent.filter((event) => !event.passed).length;
  const avgScore = recent.reduce((sum, event) => sum + event.aggregateScore, 0) / recent.length;
  const avgErrorScore = recent.reduce((sum, event) => sum + event.errorsScore, 0) / recent.length;
  const retryHeavy = recent.filter((event) => event.cycleCount > 1).length / recent.length;

  const preferManaged = (failed / recent.length) >= 0.28 || retryHeavy >= 0.35;
  const tightenErrorBypass = avgErrorScore < 82 || avgScore < 85;

  const rationale: string[] = [];
  rationale.push(`recentRuns=${recent.length}`);
  rationale.push(`failureRate=${(failed / recent.length).toFixed(2)}`);
  rationale.push(`retryRate=${retryHeavy.toFixed(2)}`);
  rationale.push(`avgScore=${avgScore.toFixed(1)}`);
  rationale.push(`avgErrorScore=${avgErrorScore.toFixed(1)}`);

  return { preferManaged, tightenErrorBypass, rationale };
}

/**
 * Applies learning signals to quality-gate runtime config.
 *
 * Implements REQ-NEXT-006 follow-through:
 * - when historical runs show instability, tighten low-risk bypass boundaries
 * - nudge pass threshold upward slightly for safer merges
 */
export function applyLearningGuidanceToQualityConfig(
  config: QualityGateConfig,
  guidance: LearningGuidance,
): QualityGateConfig {
  if (!guidance.tightenErrorBypass) return config;

  return {
    ...config,
    enforceTDD: true,
    passThreshold: Math.min(95, Math.max(config.passThreshold ?? 90, 92)),
    bypass: applyTightenedConstraints(config),
  };
}

function summarizeWindow(
  qualityEvents: QualityLearningEvent[],
  knowledgeEvents: PersistedKnowledgeTelemetryEvent[],
  startMs: number,
  endMs: number,
): AdoptionOutcomeWindow {
  const inWindowQuality = qualityEvents.filter((event) => {
    const ts = parseTimestampMs(event.timestamp) ?? 0;
    return ts >= startMs && ts < endMs;
  });
  const inWindowKnowledge = knowledgeEvents.filter((event) => {
    const ts = parseTimestampMs(event.timestamp) ?? 0;
    return ts >= startMs && ts < endMs;
  });

  const runs = inWindowQuality.length;
  const passed = inWindowQuality.filter((event) => event.passed).length;
  const retried = inWindowQuality.filter((event) => event.cycleCount > 1).length;
  const escalated = inWindowQuality.filter((event) => event.escalated).length;
  const avgScore = runs > 0
    ? inWindowQuality.reduce((sum, event) => sum + event.aggregateScore, 0) / runs
    : 0;

  const queryEvents = inWindowKnowledge.filter((event) => event.operation === 'query').length;
  const injectionEvents = inWindowKnowledge.filter((event) => event.operation === 'inject' && !event.suppressed);
  const injectionHits = injectionEvents.filter((event) => event.hit).length;
  const injectionHitRate = injectionEvents.length > 0 ? injectionHits / injectionEvents.length : null;

  return {
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    runs,
    passRate: runs > 0 ? passed / runs : 0,
    retryRate: runs > 0 ? retried / runs : 0,
    escalationRate: runs > 0 ? escalated / runs : 0,
    avgScore,
    queryCount: queryEvents,
    injectionCount: injectionEvents.length,
    injectionHitRate,
  };
}

/**
 * Compute rolling adoption outcomes for memory+learning capabilities.
 * - usage: query/injection telemetry
 * - quality impact: pass/retry/escalation deltas
 * Implements REQ-010.
 */
export function getLearningAdoptionSummary(
  workspaceRootPath: string,
  nowMs: number = Date.now(),
): AdoptionOutcomeSummary {
  const store = loadStore(workspaceRootPath);
  const currentStart = nowMs - ADOPTION_WINDOW_MS;
  const baselineStart = currentStart - ADOPTION_WINDOW_MS;

  const baseline = summarizeWindow(store.qualityEvents, store.knowledgeEvents, baselineStart, currentStart);
  const current = summarizeWindow(store.qualityEvents, store.knowledgeEvents, currentStart, nowMs);

  const thresholds = {
    minRunsPerWindow: 6,
    minQueryEvents: 8,
    minInjectionHitRate: 0.55,
    maxRetryRateIncrease: 0.08,
    maxEscalationRateIncrease: 0.05,
    minPassRate: 0.75,
  };

  const deltas = {
    retryRate: current.retryRate - baseline.retryRate,
    escalationRate: current.escalationRate - baseline.escalationRate,
    passRate: current.passRate - baseline.passRate,
    queryCount: current.queryCount - baseline.queryCount,
    injectionHitRate: current.injectionHitRate == null || baseline.injectionHitRate == null
      ? null
      : current.injectionHitRate - baseline.injectionHitRate,
  };

  const usageHealthy =
    current.queryCount >= thresholds.minQueryEvents
    && (current.injectionHitRate == null || current.injectionHitRate >= thresholds.minInjectionHitRate);
  const qualityHealthy =
    current.runs >= thresholds.minRunsPerWindow
    && current.passRate >= thresholds.minPassRate
    && deltas.retryRate <= thresholds.maxRetryRateIncrease
    && deltas.escalationRate <= thresholds.maxEscalationRateIncrease;

  return {
    baseline,
    current,
    deltas,
    thresholds,
    success: usageHealthy && qualityHealthy,
  };
}
