import { classifyTaskDomain } from './routing-policy';

export type ArchitectureMode = 'single' | 'flat' | 'managed' | 'hybrid';

export interface ArchitectureSelectorTaskInput {
  id: string;
  title: string;
  description?: string;
  dependencies?: string[];
}

export interface ArchitectureLearningHint {
  preferManaged?: boolean;
  rationale?: string;
}

export interface ArchitectureDecision {
  mode: ArchitectureMode;
  confidence: number;
  rationale: string[];
  features: {
    taskCount: number;
    meaningfulDomains: string[];
    maxTasksPerDomain: number;
    dependencyRatio: number;
    hasUxDesign: boolean;
    researchOnly: boolean;
  };
}

interface ArchitectureFeatures {
  taskCount: number;
  meaningfulDomains: string[];
  maxTasksPerDomain: number;
  dependencyRatio: number;
  hasUxDesign: boolean;
  researchOnly: boolean;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function extractArchitectureFeatures(tasks: ArchitectureSelectorTaskInput[]): ArchitectureFeatures {
  if (tasks.length <= 1) {
    return {
      taskCount: tasks.length,
      meaningfulDomains: [],
      maxTasksPerDomain: tasks.length,
      dependencyRatio: 0,
      hasUxDesign: false,
      researchOnly: false,
    };
  }

  const byDomain = new Map<string, number>();
  let dependencyEdges = 0;

  for (const task of tasks) {
    const text = `${task.title} ${task.description ?? ''}`;
    const domain = classifyTaskDomain(text).domain;
    byDomain.set(domain, (byDomain.get(domain) ?? 0) + 1);
    dependencyEdges += (task.dependencies ?? []).length;
  }

  const meaningfulDomains = Array.from(byDomain.keys()).filter((domain) => domain !== 'other');
  const maxTasksPerDomain = meaningfulDomains.length > 0
    ? Math.max(...meaningfulDomains.map((domain) => byDomain.get(domain) ?? 0))
    : tasks.length;
  const dependencyRatio = tasks.length > 0 ? dependencyEdges / tasks.length : 0;
  const hasUxDesign = meaningfulDomains.includes('ux_design');
  const researchOnly = meaningfulDomains.length > 0
    && meaningfulDomains.every((domain) => domain === 'research' || domain === 'search');

  return {
    taskCount: tasks.length,
    meaningfulDomains,
    maxTasksPerDomain,
    dependencyRatio,
    hasUxDesign,
    researchOnly,
  };
}

/**
 * Implements REQ-NEXT-002: task-aware architecture selection.
 * Returns an explicit mode + confidence + rationale for traceability logs.
 */
export function selectArchitectureMode(
  tasks: ArchitectureSelectorTaskInput[],
  options?: { learningHint?: ArchitectureLearningHint },
): ArchitectureDecision {
  const features = extractArchitectureFeatures(tasks);

  if (tasks.length <= 1) {
    return {
      mode: 'single',
      confidence: 0.97,
      rationale: ['Single task workload ??? single-agent execution minimizes orchestration overhead.'],
      features,
    };
  }

  const {
    meaningfulDomains,
    maxTasksPerDomain,
    dependencyRatio,
    hasUxDesign,
    researchOnly,
  } = features;

  const rationale: string[] = [];
  let mode: ArchitectureMode = 'flat';
  let confidence = 0.75;

  if (researchOnly) {
    mode = 'flat';
    confidence = 0.9;
    rationale.push('Research/search workload detected ??? independent execution favors flat routing.');
  } else if (hasUxDesign) {
    mode = 'managed';
    confidence = 0.95;
    rationale.push('UX/design work detected ??? managed coordination enforces design ownership and quality.');
  } else if (meaningfulDomains.length >= 3) {
    mode = 'managed';
    confidence = 0.9;
    rationale.push('Three or more active domains detected ??? managed architecture reduces coordination risk.');
  } else if (dependencyRatio >= 0.35 && tasks.length >= 4) {
    mode = 'managed';
    confidence = 0.88;
    rationale.push(`Dependency-heavy plan (ratio=${dependencyRatio.toFixed(2)}) suggests managed coordination.`);
  } else if (meaningfulDomains.length === 2) {
    if (maxTasksPerDomain <= 4) {
      mode = 'flat';
      confidence = 0.83;
      rationale.push('Two domains with low per-domain load (<=4) ??? flat execution is efficient.');
    } else {
      mode = 'managed';
      confidence = 0.86;
      rationale.push('Two domains but one has high load (>4 tasks) ??? managed split reduces bottlenecks.');
    }
  } else if (tasks.length >= 8) {
    mode = 'managed';
    confidence = 0.84;
    rationale.push('Single-domain but high task volume (>=8) ??? managed mode improves throughput control.');
  } else if (tasks.length <= 3) {
    mode = 'single';
    confidence = 0.78;
    rationale.push('Low-volume workload (<=3 tasks) ??? single-agent execution is sufficient.');
  } else {
    mode = 'flat';
    confidence = 0.78;
    rationale.push('Moderate complexity workload ??? flat mode balances speed and control.');
  }

  if (options?.learningHint?.preferManaged && mode !== 'managed') {
    mode = 'managed';
    confidence = clamp01(confidence + 0.08);
    rationale.push(options.learningHint.rationale || 'Historical learning indicates managed mode is safer for current quality trends.');
  }

  return {
    mode,
    confidence: clamp01(confidence),
    rationale,
    features: {
      ...features,
      dependencyRatio: Number(dependencyRatio.toFixed(2)),
    },
  };
}
