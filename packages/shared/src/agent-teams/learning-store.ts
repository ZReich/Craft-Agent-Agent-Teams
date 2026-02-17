import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { QualityGateConfig, QualityGateResult } from '@craft-agent/core/types';

const LEARNING_FILE = 'agent-team-learning.json';
const MAX_QUALITY_EVENTS = 300;

interface QualityLearningEvent {
  timestamp: string;
  passed: boolean;
  aggregateScore: number;
  cycleCount: number;
  architectureScore: number;
  simplicityScore: number;
  errorsScore: number;
  completenessScore: number;
}

interface LearningStoreData {
  version: 1;
  qualityEvents: QualityLearningEvent[];
}

export interface LearningGuidance {
  preferManaged: boolean;
  tightenErrorBypass: boolean;
  rationale: string[];
}

function getLearningFilePath(workspaceRootPath: string): string {
  return join(workspaceRootPath, '.craft-agent', LEARNING_FILE);
}

function loadStore(workspaceRootPath: string): LearningStoreData {
  const filePath = getLearningFilePath(workspaceRootPath);
  if (!existsSync(filePath)) {
    return { version: 1, qualityEvents: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<LearningStoreData>;
    const events = Array.isArray(parsed.qualityEvents) ? parsed.qualityEvents : [];
    return {
      version: 1,
      qualityEvents: events
        .filter((event): event is QualityLearningEvent =>
          Boolean(event && typeof event.aggregateScore === 'number' && typeof event.cycleCount === 'number'),
        )
        .slice(-MAX_QUALITY_EVENTS),
    };
  } catch {
    return { version: 1, qualityEvents: [] };
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
