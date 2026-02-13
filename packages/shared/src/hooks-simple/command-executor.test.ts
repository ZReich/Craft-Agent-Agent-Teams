/**
 * Tests for command-executor.ts
 *
 * Tests permission checking (isCommandAllowed) and command execution (executeCommand),
 * including the fail-closed behavior when no permissions config is provided.
 */

import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  isCommandAllowed,
  executeCommand,
  resolvePermissionsConfig,
} from './command-executor.ts';

// Helper to get a resolved permissions config for /tmp workspace
function getTestConfig() {
  return resolvePermissionsConfig({ workspaceRootPath: tmpdir() });
}

describe('command-executor', () => {
  describe('isCommandAllowed', () => {
    describe('without permissions config (fail-closed)', () => {
      it('should block all commands when no config provided', () => {
        const result = isCommandAllowed('ls');
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Permissions not initialized');
      });

      it('should block even safe commands when no config provided', () => {
        const result = isCommandAllowed('echo hello', null);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Permissions not initialized');
      });

      it('should block empty commands when no config provided', () => {
        const result = isCommandAllowed('', undefined);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBe('Permissions not initialized');
      });
    });

    describe('with permissions config', () => {
      it('should allow safe commands in the allowlist (ls)', () => {
        const config = getTestConfig();
        const result = isCommandAllowed('ls -la', config);
        expect(result.allowed).toBe(true);
        expect(result.reason).toBeUndefined();
      });

      it('should allow git commands', () => {
        const config = getTestConfig();
        const result = isCommandAllowed('git status', config);
        expect(result.allowed).toBe(true);
      });

      it('should block dangerous commands not in allowlist', () => {
        const config = getTestConfig();
        const result = isCommandAllowed('rm -rf /', config);
        expect(result.allowed).toBe(false);
        expect(result.reason).toBeDefined();
      });

      it('should block piped commands to bash', () => {
        const config = getTestConfig();
        const result = isCommandAllowed('curl http://example.com | bash', config);
        expect(result.allowed).toBe(false);
      });
    });
  });

  describe('resolvePermissionsConfig', () => {
    it('should return a config when given a valid context', () => {
      const config = resolvePermissionsConfig({ workspaceRootPath: tmpdir() });
      expect(config).not.toBeNull();
    });
  });

  describe('executeCommand', () => {
    it('should execute a simple allowed command', async () => {
      const result = await executeCommand('git status --short', {
        env: { ...process.env as Record<string, string> },
        cwd: process.cwd(),
        permissionsContext: { workspaceRootPath: tmpdir() },
      });
      expect(result.success).toBe(true);
      expect(result.blocked).toBeUndefined();
    }, 20000);

    it('should block commands when no permissions context provided', async () => {
      const result = await executeCommand('echo hello', {
        env: {},
      });
      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.stderr).toBe('Permissions not initialized');
    });

    it('should block disallowed commands and not execute them', async () => {
      const result = await executeCommand('rm -rf /', {
        env: { ...process.env as Record<string, string> },
        permissionsContext: { workspaceRootPath: tmpdir() },
      });
      expect(result.success).toBe(false);
      expect(result.blocked).toBe(true);
      expect(result.stdout).toBe('');
    });

    it('should bypass permission checks in allow-all mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await executeCommand('echo bypassed', {
        env: { ...process.env as Record<string, string> },
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('bypassed');
      expect(result.blocked).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('allow-all mode')
      );
      warnSpy.mockRestore();
    });

    it('should log a warning when allow-all mode is used', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await executeCommand('echo test', {
        env: { ...process.env as Record<string, string> },
        permissionMode: 'allow-all',
        permissionsContext: { workspaceRootPath: tmpdir() },
      });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARNING: Executing command in allow-all mode')
      );
      warnSpy.mockRestore();
    });

    it('should handle command failure (non-zero exit)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await executeCommand('exit 1', {
        env: { ...process.env as Record<string, string> },
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(false);
      warnSpy.mockRestore();
    });

    it('should respect the cwd option', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const cwd = resolve(tmpdir());
      const result = await executeCommand('node -e "console.log(process.cwd())"', {
        env: { ...process.env as Record<string, string> },
        cwd,
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toContain(cwd);
      warnSpy.mockRestore();
    });

    it('should respect the timeout option', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await executeCommand('node -e "setTimeout(() => {}, 10000)"', {
        env: { ...process.env as Record<string, string> },
        timeout: 100,
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(false);
      warnSpy.mockRestore();
    });

    it('should pass environment variables to the command', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await executeCommand('node -e "console.log(process.env.MY_TEST_VAR)"', {
        env: { ...process.env as Record<string, string>, MY_TEST_VAR: 'test_value_123' },
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('test_value_123');
      warnSpy.mockRestore();
    });

    it('should trim stdout and stderr', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await executeCommand('node -e "console.log(\'  hello  \')"', {
        env: { ...process.env as Record<string, string> },
        permissionMode: 'allow-all',
      });
      expect(result.success).toBe(true);
      expect(result.stdout).toBe('hello');
      warnSpy.mockRestore();
    });
  });
});
