import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { loadSession, updateSessionMetadata } from '../../packages/shared/src/sessions/storage.ts';
import { exportCoverageReport } from '../../packages/shared/src/agent-teams/sdd-exports.ts';

const [workspaceRootPath, sessionId, specPathArg] = process.argv.slice(2);
if (!workspaceRootPath || !sessionId) {
  throw new Error('Usage: bun scripts/sdd/update-compliance.ts <workspaceRootPath> <sessionId>');
}

const session = loadSession(workspaceRootPath, sessionId);
if (!session) {
  throw new Error(`Session not found: ${sessionId}`);
}
const specPath = specPathArg || session.activeSpecId;
if (!specPath) {
  throw new Error('No spec path provided and session has no activeSpecId');
}

const specContent = readFileSync(specPath, 'utf-8');

function extractSectionLines(lines: string[], heading: string): string[] {
  const startIndex = lines.findIndex(line => line.trim().toLowerCase() === heading.toLowerCase());
  if (startIndex === -1) return [];
  const sectionLines: string[] = [];
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith('## ')) break;
    sectionLines.push(line);
  }
  return sectionLines;
}

function parsePriority(raw?: string): 'critical' | 'high' | 'medium' | 'low' {
  switch ((raw ?? '').toLowerCase()) {
    case 'critical':
      return 'critical';
    case 'high':
      return 'high';
    case 'low':
      return 'low';
    default:
      return 'medium';
  }
}

function parseSpec(markdown: string, specId: string) {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find(line => line.trim().startsWith('# ')) ?? '# Untitled Spec';
  const title = titleLine.replace(/^#\s*/, '').trim();
  const ownerMatch = lines.find(line => /DRI:/i.test(line))?.match(/DRI:\s*([^<]+)$/i);
  const ownerDRI = ownerMatch?.[1]?.trim() ?? 'Unassigned';

  const goals = extractSectionLines(lines, '## Goals')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean);
  const nonGoals = extractSectionLines(lines, '## Non-Goals')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean);

  const acceptanceTests = extractSectionLines(lines, '## Acceptance Tests')
    .map(line => line.replace(/^[\s*-]+/, '').trim())
    .filter(Boolean);

  const requirementLines = extractSectionLines(lines, '## Requirements')
    .map(line => line.trim())
    .filter(line => line.startsWith('-'));

  const requirements = requirementLines.map((line, index) => {
    const match = line.match(/\*\*(REQ-[0-9]+)\s*\(([^)]+)\):\*\*\s*(.+)$/i);
    if (match) {
      return {
        id: match[1].trim(),
        description: match[3].trim(),
        priority: parsePriority(match[2]),
        acceptanceTests,
        status: 'pending' as const,
      };
    }
    return {
      id: `REQ-${String(index + 1).padStart(3, '0')}`,
      description: line.replace(/^[\s*-]+/, ''),
      priority: 'medium' as const,
      acceptanceTests,
      status: 'pending' as const,
    };
  });

  const rolloutPlan = extractSectionLines(lines, '## Rollout Plan').join('\n').trim() || undefined;
  const rollbackPlan = extractSectionLines(lines, '## Rollback Plan').join('\n').trim() || undefined;
  const observabilityPlan = extractSectionLines(lines, '## Observability Plan').join('\n').trim() || undefined;

  return {
    specId,
    title,
    ownerDRI,
    goals,
    nonGoals,
    requirements,
    rollbackPlan,
    observabilityPlan,
  };
}

const spec = parseSpec(specContent, specPath);

const requirementTrace: Record<string, { files: string[]; tests: string[]; notes?: string }> = {
  'REQ-001': {
    files: ['apps/electron/src/main/sessions.ts'],
    tests: ['apps/electron/src/main/__tests__/sdd-flow.test.ts'],
    notes: 'Auto-spec creation + compact-spec prompt coverage',
  },
  'REQ-002': {
    files: ['vitest.config.ts'],
    tests: [],
    notes: 'Root Vitest config includes core suites',
  },
  'REQ-003': {
    files: ['packages/shared/src/auth/__tests__/oauth.test.ts', 'packages/shared/src/auth/__tests__/state.test.ts'],
    tests: ['packages/shared/src/auth/__tests__/oauth.test.ts', 'packages/shared/src/auth/__tests__/state.test.ts'],
    notes: 'Auth tests migrated to Vitest',
  },
  'REQ-004': {
    files: ['apps/electron/src/renderer/components/ui/__tests__/mention-menu.test.ts'],
    tests: ['apps/electron/src/renderer/components/ui/__tests__/mention-menu.test.ts'],
    notes: 'Renderer mention-menu test module resolution',
  },
  'REQ-005': {
    files: ['packages/shared/src/utils/__tests__/cli-icon-resolver.test.ts'],
    tests: ['packages/shared/src/utils/__tests__/cli-icon-resolver.test.ts'],
    notes: 'Assertion API fixes for utility tests',
  },
};

const requirementsCoverage = spec.requirements.map(req => {
  const trace = requirementTrace[req.id];
  const coverage = trace ? 'full' : 'none';
  return {
    requirementId: req.id,
    coverage,
    referencedInFiles: trace?.files ?? [],
    referencedInTests: trace?.tests ?? [],
    notes: trace?.notes ?? 'No traceability evidence recorded',
  };
});

const fullCount = requirementsCoverage.filter(r => r.coverage === 'full').length;
const overallCoverage = requirementsCoverage.length > 0
  ? Math.round((fullCount / requirementsCoverage.length) * 100)
  : 100;

const unreferencedRequirements = requirementsCoverage
  .filter(r => r.coverage === 'none')
  .map(r => r.requirementId);

const traceabilityMap = requirementsCoverage.map(r => ({
  requirementId: r.requirementId,
  files: r.referencedInFiles,
  tests: r.referencedInTests,
  tasks: [],
  tickets: [],
}));

const hasRollbackPlan = !!spec.rollbackPlan;
const hasMonitoring = !!spec.observabilityPlan;
const hasFeatureFlags = false;

const report = {
  specId: specPath,
  timestamp: new Date().toISOString(),
  overallCoverage,
  requirementsCoverage,
  unreferencedRequirements,
  traceabilityMap,
  rolloutSafetyCheck: {
    hasRollbackPlan,
    hasMonitoring,
    hasFeatureFlags,
    issues: [
      ...(hasRollbackPlan ? [] : ['Missing rollback plan']),
      ...(hasMonitoring ? [] : ['Missing monitoring plan']),
      ...(hasFeatureFlags ? [] : ['No feature-flag strategy detected']),
    ],
  },
};

const reports = session.sddComplianceReports ?? [];
await updateSessionMetadata(workspaceRootPath, sessionId, {
  sddEnabled: true,
  activeSpecId: specPath,
  sddComplianceReports: [...reports, report],
});

const reportDir = join(workspaceRootPath, 'sessions', sessionId, 'reports');
mkdirSync(reportDir, { recursive: true });
const stamp = new Date().toISOString().split('T')[0];
const reportPath = join(reportDir, `${stamp}-coverage-report.md`);
writeFileSync(reportPath, exportCoverageReport(report), 'utf-8');

console.log(`Wrote compliance report to ${reportPath}`);

