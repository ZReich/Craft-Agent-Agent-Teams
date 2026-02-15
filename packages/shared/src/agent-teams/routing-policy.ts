/**
 * Agent Teams Routing Policy
 *
 * Implements:
 * - REQ-004: task-domain classification
 * - REQ-005: UX/Design → Head teammate → Opus (hard enforcement)
 * - REQ-006: deterministic skill-pack selection (via skill mentions in prompts)
 */

import type { TeamRole } from '@craft-agent/core/types';

export type TaskDomain =
  | 'ux_design'
  | 'frontend'
  | 'backend'
  | 'research'
  | 'search'
  | 'review'
  | 'other';

export interface DomainClassification {
  domain: TaskDomain;
  matchedKeywords: string[];
}

export interface RoutingDecision {
  domain: TaskDomain;
  /** Final role after policy defaults/enforcement */
  role: TeamRole;
  /** Whether the policy had to override the requested role */
  roleEnforced: boolean;
  /** Optional model override (highest priority) */
  modelOverride?: string;
  /** Skill slugs to mention in kickoff prompt (deterministic) */
  skillSlugs: string[];
  /** Human-readable explanation for logs/audits */
  reason: string;
}

const DOMAIN_KEYWORDS: Record<TaskDomain, string[]> = {
  ux_design: [
    'ux',
    'user flow',
    'wireframe',
    'a11y',
    'accessibility',
    'visual design',
    'layout',
    'design system',
    'component spec',
    'interaction',
  ],
  review: [
    'review',
    'qa',
    'quality gate',
    'acceptance test',
    'regression',
    'verify',
    'validate',
  ],
  frontend: [
    'frontend',
    'react',
    'component',
    'css',
    'ui',
    'renderer',
    'electron renderer',
  ],
  backend: [
    'backend',
    'api',
    'endpoint',
    'database',
    'db',
    'migration',
    'service',
    'auth',
  ],
  search: [
    'search',
    'grep',
    'ripgrep',
    'where is',
    'find usage',
    'locate',
    'map repo',
  ],
  research: [
    'research',
    'compare',
    'best practice',
    'tradeoff',
    'docs',
    'documentation',
  ],
  other: [],
};

const DOMAIN_PRIORITY: TaskDomain[] = [
  'ux_design',
  'review',
  'frontend',
  'backend',
  'search',
  'research',
  'other',
];

export function classifyTaskDomain(text: string): DomainClassification {
  const t = (text || '').toLowerCase();
  for (const domain of DOMAIN_PRIORITY) {
    const keywords = DOMAIN_KEYWORDS[domain];
    const matched = keywords.filter((k) => t.includes(k));
    if (matched.length > 0) {
      return { domain, matchedKeywords: matched.slice(0, 5) };
    }
  }
  return { domain: 'other', matchedKeywords: [] };
}

function defaultRoleForDomain(domain: TaskDomain): TeamRole {
  switch (domain) {
    case 'review':
      return 'reviewer';
    case 'ux_design':
      return 'head';
    case 'frontend':
    case 'backend':
    case 'search':
    case 'research':
    case 'other':
    default:
      return 'worker';
  }
}

function skillSlugsForDomain(domain: TaskDomain, role: TeamRole): string[] {
  // Keep this minimal to reduce context bloat.
  if (domain === 'ux_design') return ['ux-ui-designer'];
  if (domain === 'frontend') return ['frontend-implementer'];
  if (domain === 'backend') return ['backend-implementer'];
  if (domain === 'search' || domain === 'research') return ['codebase-cartographer'];
  if (domain === 'review' || role === 'reviewer') return ['quality-reviewer'];
  return [];
}

/**
 * Decide teammate routing from a prompt + optional requested role/model.
 *
 * Hard enforcement:
 * - UX/Design work is always routed to Head + Opus.
 */
export function decideTeammateRouting(input: {
  prompt: string;
  requestedRole?: TeamRole;
  requestedModel?: string;
}): RoutingDecision {
  const classification = classifyTaskDomain(input.prompt);

  const requestedRole = input.requestedRole;
  let role: TeamRole = requestedRole ?? defaultRoleForDomain(classification.domain);
  let roleEnforced = false;

  // Implements REQ-005: UX/Design hard enforcement
  if (classification.domain === 'ux_design' && role !== 'head') {
    role = 'head';
    roleEnforced = true;
  }

  const modelOverride = classification.domain === 'ux_design'
    ? 'claude-opus-4-6'
    : undefined;

  const skillSlugs = skillSlugsForDomain(classification.domain, role);

  const reasonParts: string[] = [];
  reasonParts.push(`domain=${classification.domain}`);
  if (classification.matchedKeywords.length > 0) {
    reasonParts.push(`matched=${classification.matchedKeywords.join(',')}`);
  }
  if (requestedRole) {
    reasonParts.push(`requestedRole=${requestedRole}`);
  }
  if (roleEnforced) {
    reasonParts.push(`enforcedRole=head`);
  }
  if (modelOverride) {
    reasonParts.push(`enforcedModel=${modelOverride}`);
  }
  if (skillSlugs.length > 0) {
    reasonParts.push(`skills=${skillSlugs.join(',')}`);
  }

  return {
    domain: classification.domain,
    role,
    roleEnforced,
    modelOverride,
    skillSlugs,
    reason: reasonParts.join(' '),
  };
}

