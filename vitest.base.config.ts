import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

// Implements REQ-002: Disable debug logging during tests to prevent ConfigWatcher
// and other debug logs from polluting test output (quality gate JSON parse failures)
process.env.CRAFT_DEBUG = '0';

// Implements REQ-001: Shared base Vitest config for all projects
export default defineConfig({
  resolve: {
    alias: [
      { find: 'bun:test', replacement: 'vitest' },
      { find: '@craft-agent/shared/agent/backend', replacement: resolve(__dirname, 'packages/shared/src/agent/backend/index.ts') },
      { find: '@craft-agent/shared/agent/modes', replacement: resolve(__dirname, 'packages/shared/src/agent/mode-manager.ts') },
      { find: /^@craft-agent\/shared\/(.*)$/, replacement: resolve(__dirname, 'packages/shared/src/$1') },
      { find: '@', replacement: resolve(__dirname, 'apps/electron/src/renderer') },
    ],
  },
  test: {
    // Environment is set at top of file (before modules load) to ensure debug logging is disabled
    passWithNoTests: false,
  },
});
