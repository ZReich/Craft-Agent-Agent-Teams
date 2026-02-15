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
});

