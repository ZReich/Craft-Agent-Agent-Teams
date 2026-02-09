/**
 * SDD Export Utilities
 *
 * Generates exportable reports in Markdown and JSON format
 * for spec summaries, coverage reports, and quality gate results.
 */

import type {
  Spec,
  SpecComplianceReport,
  TraceabilityEntry,
  QualityGateResult,
  QualityGateStageName,
  QualityGateStageResult,
} from '@craft-agent/core/types';

// ============================================================
// Spec Summary Export
// ============================================================

/**
 * Generate a Markdown summary of a spec document.
 */
export function exportSpecSummary(spec: Spec): string {
  const lines: string[] = [];

  lines.push(`# Spec: ${spec.title}`);
  lines.push('');
  lines.push(`**Status:** ${spec.status} | **Owner DRI:** ${spec.ownerDRI} | **Reviewers:** ${spec.reviewers.join(', ') || 'None'}`);
  lines.push(`**Created:** ${spec.createdAt} | **Updated:** ${spec.updatedAt}`);
  lines.push('');

  // Goals
  if (spec.goals.length > 0) {
    lines.push('## Goals');
    for (const goal of spec.goals) {
      lines.push(`- ${goal}`);
    }
    lines.push('');
  }

  // Non-Goals
  if (spec.nonGoals.length > 0) {
    lines.push('## Non-Goals');
    for (const nonGoal of spec.nonGoals) {
      lines.push(`- ${nonGoal}`);
    }
    lines.push('');
  }

  // Requirements
  lines.push(`## Requirements (${spec.requirements.length})`);
  lines.push('');
  if (spec.requirements.length > 0) {
    lines.push('| ID | Priority | Description | Status | DRI |');
    lines.push('|----|----------|-------------|--------|-----|');
    for (const req of spec.requirements) {
      lines.push(`| ${req.id} | ${req.priority} | ${req.description} | ${req.status} | ${req.assignedDRI || '—'} |`);
    }
  } else {
    lines.push('_No requirements defined._');
  }
  lines.push('');

  // Risks
  if (spec.risks.length > 0) {
    lines.push('## Risks');
    lines.push('');
    lines.push('| ID | Severity | Description | Mitigation | Status |');
    lines.push('|----|----------|-------------|------------|--------|');
    for (const risk of spec.risks) {
      lines.push(`| ${risk.id} | ${risk.severity} | ${risk.description} | ${risk.mitigation} | ${risk.status} |`);
    }
    lines.push('');
  }

  // Related Tickets
  if (spec.relatedTickets.length > 0) {
    lines.push('## Related Tickets');
    lines.push('');
    lines.push('| Provider | ID | Title | Status |');
    lines.push('|----------|----|-------|--------|');
    for (const ticket of spec.relatedTickets) {
      lines.push(`| ${ticket.provider} | ${ticket.ticketId} | ${ticket.title || '—'} | ${ticket.status || '—'} |`);
    }
    lines.push('');
  }

  // Plans
  const hasPlans = spec.rolloutPlan || spec.rollbackPlan || spec.testPlan || spec.observabilityPlan;
  if (hasPlans) {
    lines.push('## Plans');
    lines.push('');
    if (spec.rolloutPlan) {
      lines.push('### Rollout Plan');
      lines.push(spec.rolloutPlan);
      lines.push('');
    }
    if (spec.rollbackPlan) {
      lines.push('### Rollback Plan');
      lines.push(spec.rollbackPlan);
      lines.push('');
    }
    if (spec.testPlan) {
      lines.push('### Test Plan');
      lines.push(spec.testPlan);
      lines.push('');
    }
    if (spec.observabilityPlan) {
      lines.push('### Observability Plan');
      lines.push(spec.observabilityPlan);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ============================================================
// Coverage Report Export
// ============================================================

/**
 * Generate a Markdown coverage report from a SpecComplianceReport.
 */
export function exportCoverageReport(report: SpecComplianceReport): string {
  const lines: string[] = [];

  lines.push('# Coverage Report');
  lines.push('');
  lines.push(`**Spec:** ${report.specId} | **Generated:** ${report.timestamp}`);
  lines.push(`**Overall Coverage:** ${report.overallCoverage}%`);
  lines.push('');

  // Requirement Coverage Table
  lines.push('## Requirement Coverage');
  lines.push('');
  if (report.requirementsCoverage.length > 0) {
    lines.push('| Requirement | Coverage | Files | Tests | Notes |');
    lines.push('|-------------|----------|-------|-------|-------|');
    for (const cov of report.requirementsCoverage) {
      const fileCount = cov.referencedInFiles.length;
      const testCount = cov.referencedInTests.length;
      lines.push(`| ${cov.requirementId} | ${cov.coverage} | ${fileCount} file${fileCount !== 1 ? 's' : ''} | ${testCount} test${testCount !== 1 ? 's' : ''} | ${cov.notes || '—'} |`);
    }
  } else {
    lines.push('_No coverage data available._');
  }
  lines.push('');

  // Unreferenced Requirements
  if (report.unreferencedRequirements.length > 0) {
    lines.push('## Unreferenced Requirements');
    lines.push('');
    for (const reqId of report.unreferencedRequirements) {
      lines.push(`- ${reqId} (not found in output)`);
    }
    lines.push('');
  }

  // Traceability Map
  if (report.traceabilityMap.length > 0) {
    lines.push('## Traceability Map');
    lines.push('');
    lines.push('| Requirement | Files | Tests | Tasks | Tickets |');
    lines.push('|-------------|-------|-------|-------|---------|');
    for (const entry of report.traceabilityMap) {
      lines.push(`| ${entry.requirementId} | ${entry.files.join(', ') || '—'} | ${entry.tests.join(', ') || '—'} | ${entry.tasks.join(', ') || '—'} | ${entry.tickets.join(', ') || '—'} |`);
    }
    lines.push('');
  }

  // Rollout Safety
  if (report.rolloutSafetyCheck) {
    const safety = report.rolloutSafetyCheck;
    lines.push('## Rollout Safety');
    lines.push('');
    lines.push(`- **Rollback Plan:** ${safety.hasRollbackPlan ? 'Yes' : 'No'}`);
    lines.push(`- **Monitoring:** ${safety.hasMonitoring ? 'Yes' : 'No'}`);
    lines.push(`- **Feature Flags:** ${safety.hasFeatureFlags ? 'Yes' : 'No'}`);
    if (safety.issues.length > 0) {
      lines.push('');
      lines.push('**Issues:**');
      for (const issue of safety.issues) {
        lines.push(`- ${issue}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Quality Gate Results Export
// ============================================================

const STAGE_DISPLAY_NAMES: Record<string, string> = {
  syntax: 'Syntax & Types',
  tests: 'Test Execution',
  architecture: 'Architecture Review',
  simplicity: 'Simplicity Review',
  errors: 'Error Analysis',
  completeness: 'Completeness Check',
  spec_compliance: 'Spec Compliance',
  traceability: 'Requirement Traceability',
  rollout_safety: 'Rollout Safety',
};

/**
 * Generate a Markdown quality gate results report.
 */
export function exportGateResults(results: QualityGateResult, specId?: string): string {
  const lines: string[] = [];

  lines.push('# Quality Gate Report');
  lines.push('');
  const specLabel = specId ? `**Spec:** ${specId} | ` : '';
  lines.push(`${specLabel}**Score:** ${results.aggregateScore}/100 | **Status:** ${results.passed ? 'PASSED' : 'FAILED'}`);
  lines.push(`**Review Model:** ${results.reviewModel} | **Cycles:** ${results.cycleCount}/${results.maxCycles}`);
  if (results.escalatedTo) {
    lines.push(`**Escalated To:** ${results.escalatedTo}`);
  }
  lines.push(`**Timestamp:** ${results.timestamp}`);
  lines.push('');

  // Stage Results Table
  lines.push('## Stage Results');
  lines.push('');
  lines.push('| Stage | Score | Status | Issues |');
  lines.push('|-------|-------|--------|--------|');

  for (const [name, stageResult] of Object.entries(results.stages) as [string, QualityGateStageResult][]) {
    const displayName = STAGE_DISPLAY_NAMES[name] || name;
    const status = stageResult.passed ? 'PASS' : 'FAIL';
    lines.push(`| ${displayName} | ${stageResult.score}/100 | ${status} | ${stageResult.issues.length} |`);
  }
  lines.push('');

  // Detailed Issues
  const stagesWithIssues = (Object.entries(results.stages) as [string, QualityGateStageResult][])
    .filter(([, sr]) => sr.issues.length > 0);

  if (stagesWithIssues.length > 0) {
    lines.push('## Issues');
    lines.push('');
    for (const [name, stageResult] of stagesWithIssues) {
      const displayName = STAGE_DISPLAY_NAMES[name] || name;
      lines.push(`### ${displayName}`);
      for (const issue of stageResult.issues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }
  }

  // Suggestions
  const allSuggestions: string[] = [];
  for (const [, stageResult] of Object.entries(results.stages) as [string, QualityGateStageResult][]) {
    allSuggestions.push(...stageResult.suggestions);
  }

  if (allSuggestions.length > 0) {
    lines.push('## Suggestions');
    lines.push('');
    for (const suggestion of allSuggestions) {
      lines.push(`- ${suggestion}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================
// Full Bundle Export
// ============================================================

/**
 * Generate a JSON export bundle with all SDD data.
 */
export function exportSDDBundle(data: {
  spec: Spec;
  complianceReport?: SpecComplianceReport;
  gateResults?: QualityGateResult[];
  traceabilityMap?: TraceabilityEntry[];
}): string {
  return JSON.stringify(data, null, 2);
}
