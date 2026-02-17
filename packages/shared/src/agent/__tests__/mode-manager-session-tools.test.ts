import { describe, it, expect } from 'vitest';
import { shouldAllowToolInMode } from '../mode-manager';

describe('mode-manager session team tools in Explore mode', () => {
  it('allows agent-team control-plane session tools in safe mode', () => {
    const tools = [
      'mcp__session__Task',
      'mcp__session__SendMessage',
      'mcp__session__TeamCreate',
      'mcp__session__TeamDelete',
      'mcp__session__TeamKnowledgeQuery',
    ];

    for (const tool of tools) {
      const result = shouldAllowToolInMode(tool, {}, 'safe');
      expect(result.allowed).toBe(true);
    }
  });

  it('still blocks source mutation session tools in safe mode', () => {
    const result = shouldAllowToolInMode('mcp__session__source_oauth_trigger', {}, 'safe');
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('Session configuration changes are blocked');
    }
  });
});
