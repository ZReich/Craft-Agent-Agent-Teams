import { describe, it, expect } from 'vitest';
import { classifyTaskDomain, decideTeammateRouting } from './routing-policy';

describe('agent teams routing policy', () => {
  it('classifies ux/design domain by keywords', () => {
    const c = classifyTaskDomain('Create a wireframe and accessibility checklist for the settings screen');
    expect(c.domain).toBe('ux_design');
    expect(c.matchedKeywords.length).toBeGreaterThan(0);
  });

  it('hard-enforces ux/design to head + opus even when worker requested', () => {
    const d = decideTeammateRouting({
      prompt: 'UX: propose user flows and wireframes for onboarding',
      requestedRole: 'worker',
      requestedModel: 'kimi-k2.5',
    });

    expect(d.domain).toBe('ux_design');
    expect(d.role).toBe('head');
    expect(d.roleEnforced).toBe(true);
    expect(d.modelOverride).toBe('claude-opus-4-6');
    expect(d.skillSlugs).toContain('ux-ui-designer');
  });

  it('routes frontend work to frontend skill pack by default', () => {
    const d = decideTeammateRouting({
      prompt: 'Frontend: implement a React component with CSS styles',
    });
    expect(d.domain).toBe('frontend');
    expect(d.role).toBe('worker');
    expect(d.skillSlugs).toEqual(['frontend-implementer']);
  });

  it('routes review work to reviewer role by default', () => {
    const d = decideTeammateRouting({
      prompt: 'QA: review and validate acceptance tests',
    });
    expect(d.domain).toBe('review');
    expect(d.role).toBe('reviewer');
    expect(d.skillSlugs).toEqual(['quality-reviewer']);
  });

  it('routes testing work to test-writer by default', () => {
    const d = decideTeammateRouting({
      prompt: 'Write unit tests and improve coverage for routing behavior',
    });
    expect(d.domain).toBe('testing');
    expect(d.role).toBe('worker');
    expect(d.skillSlugs).toEqual(['test-writer']);
  });

  it('routes integration work to integration-fixer by default', () => {
    const d = decideTeammateRouting({
      prompt: 'Integration: fix cross-module wiring and end-to-end contract mismatch',
    });
    expect(d.domain).toBe('integration');
    expect(d.role).toBe('worker');
    expect(d.skillSlugs).toEqual(['integration-fixer']);
  });

  it('routes escalation work to escalation role with escalation-specialist skill', () => {
    const d = decideTeammateRouting({
      prompt: 'Escalate this blocked task with unresolved critical risk',
    });
    expect(d.domain).toBe('escalation');
    expect(d.role).toBe('escalation');
    expect(d.skillSlugs).toEqual(['escalation-specialist']);
  });

  it('routes planning work to spec-planner', () => {
    const d = decideTeammateRouting({
      prompt: 'Create a spec and requirements planning breakdown for this feature',
    });
    expect(d.domain).toBe('planning');
    expect(d.role).toBe('worker');
    expect(d.skillSlugs).toEqual(['spec-planner']);
  });

  it('routes docs work to docs-maintainer', () => {
    const d = decideTeammateRouting({
      prompt: 'Update documentation and migration notes for this change',
    });
    expect(d.domain).toBe('docs');
    expect(d.role).toBe('worker');
    expect(d.skillSlugs).toEqual(['docs-maintainer']);
  });
});
