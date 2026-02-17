import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { buildOverrideSnippet, createToolOverrideResult, didToolOverrideApply } from '../sdk-interception';

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

describe('sdk interception contract (REQ-NEXT-007)', () => {
  it('creates synthetic override payload through a single abstraction', () => {
    const result = createToolOverrideResult('hello world');
    expect(result).toEqual({ outputContent: 'hello world' });
  });

  it('detects whether synthetic tool override appears in post-tool output', () => {
    const snippet = buildOverrideSnippet('Teammate spawned successfully as a separate session.');
    expect(didToolOverrideApply(`OK: ${snippet}`, snippet)).toBe(true);
    expect(didToolOverrideApply('different response', snippet)).toBe(false);
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
  });
});
