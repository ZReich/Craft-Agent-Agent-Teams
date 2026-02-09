import { describe, it, expect } from 'bun:test';
import { MODEL_PRESETS } from '../src/providers/presets';

describe('agent team presets', () => {
  it('includes Codex presets', () => {
    const ids = MODEL_PRESETS.map((preset) => preset.id);
    expect(ids).toContain('codex-balanced');
    expect(ids).toContain('codex-full');
  });

  it('Codex presets use Codex models for lead/head', () => {
    const codexBalanced = MODEL_PRESETS.find((preset) => preset.id === 'codex-balanced');
    const codexFull = MODEL_PRESETS.find((preset) => preset.id === 'codex-full');

    expect(codexBalanced?.config.defaults.lead.model).toContain('codex');
    expect(codexBalanced?.config.defaults.head.model).toContain('codex');
    expect(codexFull?.config.defaults.lead.model).toContain('codex');
    expect(codexFull?.config.defaults.head.model).toContain('codex');
  });
});
