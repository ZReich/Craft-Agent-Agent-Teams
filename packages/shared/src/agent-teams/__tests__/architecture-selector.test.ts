import { describe, expect, it } from 'vitest';
import { selectArchitectureMode } from '../architecture-selector';

describe('selectArchitectureMode', () => {
  it('returns single mode for a single task', () => {
    const decision = selectArchitectureMode([{ id: '1', title: 'Fix typo in docs' }]);
    expect(decision.mode).toBe('single');
    expect(decision.confidence).toBeGreaterThan(0.7);
  });

  it('returns flat mode for low-load two-domain workloads', () => {
    const decision = selectArchitectureMode([
      { id: '1', title: 'Build React settings panel' },
      { id: '2', title: 'Build React dashboard' },
      { id: '3', title: 'Create backend API endpoint for settings' },
      { id: '4', title: 'Add backend validation for settings endpoint' },
    ]);
    expect(decision.mode).toBe('flat');
  });

  it('returns managed mode for ux/design workloads', () => {
    const decision = selectArchitectureMode([
      { id: '1', title: 'Create UX wireframes for onboarding' },
      { id: '2', title: 'Implement onboarding renderer components' },
    ]);
    expect(decision.mode).toBe('managed');
    expect(decision.features.hasUxDesign).toBe(true);
  });

  it('honors learning hint that prefers managed mode', () => {
    const decision = selectArchitectureMode(
      [
        { id: '1', title: 'Build React header' },
        { id: '2', title: 'Build React footer' },
        { id: '3', title: 'Build React sidebar' },
      ],
      { learningHint: { preferManaged: true, rationale: 'historical retries are elevated' } },
    );
    expect(decision.mode).toBe('managed');
    expect(decision.rationale.join(' ')).toContain('historical retries are elevated');
  });
});

