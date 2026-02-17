import { describe, it, expect } from 'vitest';
import { DEFAULT_QUALITY_GATE_CONFIG, mergeQualityGateConfig } from '../quality-gates';

describe('quality gate phase-one config defaults', () => {
  it('enables combined review by default (REQ-NEXT-012)', () => {
    expect(DEFAULT_QUALITY_GATE_CONFIG.useCombinedReview).toBe(true);
  });

  it('enables low-risk bypass defaults (REQ-NEXT-013)', () => {
    const bypass = DEFAULT_QUALITY_GATE_CONFIG.bypass;
    expect(bypass).toBeDefined();
    expect(bypass!.enabled).toBe(true);
    expect(bypass!.architecture!.maxDiffLines).toBe(50);
    expect(bypass!.simplicity!.maxDiffLines).toBe(100);
    expect(bypass!.errors!.maxDiffLines).toBe(50);
  });

  it('deep-merges partial bypass overrides', () => {
    const merged = mergeQualityGateConfig({
      bypass: {
        architecture: { maxDiffLines: 25 },
      },
    } as any);

    const bypass = merged.bypass;
    expect(bypass).toBeDefined();
    expect(bypass!.architecture!.maxDiffLines).toBe(25);
    expect(bypass!.architecture!.maxFilesChanged).toBe(2);
    expect(bypass!.errors!.defaultScore).toBe(90);
  });
});
