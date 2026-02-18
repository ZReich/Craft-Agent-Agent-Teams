import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { didToolOverrideMatch } from '../sdk-interception';

function findSdkDtsPath(): string | null {
  const searchRoots = [
    process.cwd(),
    join(process.cwd(), '..'),
    join(process.cwd(), '..', '..'),
  ];

  for (const root of searchRoots) {
    const directPath = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.d.ts');
    if (existsSync(directPath)) {
      return directPath;
    }

    const bunModulesDir = join(root, 'node_modules', '.bun');
    if (!existsSync(bunModulesDir)) {
      continue;
    }

    const sdkDir = readdirSync(bunModulesDir)
      .filter((entry) => entry.startsWith('@anthropic-ai+claude-agent-sdk@'))
      .sort()
      .at(-1);

    if (!sdkDir) {
      continue;
    }

    const bunDtsPath = join(
      bunModulesDir,
      sdkDir,
      'node_modules',
      '@anthropic-ai',
      'claude-agent-sdk',
      'sdk.d.ts',
    );

    if (existsSync(bunDtsPath)) {
      return bunDtsPath;
    }
  }

  return null;
}

// Implements REQ-NEXT-007: Stabilize SDK interception layer.
describe('sdk interception contract (REQ-NEXT-007)', () => {
  // Basic helper test
  it('didToolOverrideMatch finds expected snippet in actual result', () => {
    expect(didToolOverrideMatch('hello', 'OK: hello world')).toBe(true);
    expect(didToolOverrideMatch('hello', 'different response')).toBe(false);
    expect(didToolOverrideMatch('', 'anything')).toBe(true);
    expect(didToolOverrideMatch('something', '')).toBe(false);
  });

  it('asserts SDK hook type contract shape for PreToolUse remains recognizable', () => {
    const dtsPath = findSdkDtsPath();
    expect(dtsPath).toBeTruthy();
    if (!dtsPath) {
      throw new Error('Unable to locate @anthropic-ai/claude-agent-sdk/sdk.d.ts for contract check');
    }
    const sdkDts = readFileSync(dtsPath, 'utf8');

    // Fail loudly on SDK type-shape drift so interception behavior is re-verified.
    expect(sdkDts).toContain('type PreToolUseHookSpecificOutput');
    expect(sdkDts).toContain('permissionDecision?:');
    expect(sdkDts).toContain('updatedInput?: Record<string, unknown>');
    expect(sdkDts).toContain('type SyncHookJSONOutput');
    // Regression guard: outputContent must NOT appear in the SDK types.
    // If the SDK ever adds official support, we can replace decision:'block' with a better mechanism.
    expect(sdkDts).not.toContain('outputContent');
  });

  it('asserts decision:block is a valid SDK SyncHookJSONOutput decision value', () => {
    // This verifies the mechanism we now use for agent team tool interception is officially supported.
    const dtsPath = findSdkDtsPath();
    if (!dtsPath) return; // skip if SDK not found (covered by other test)
    const sdkDts = readFileSync(dtsPath, 'utf8');
    // decision field should have 'block' as an approved value
    expect(sdkDts).toContain("'approve' | 'block'");
  });
});
