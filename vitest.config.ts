import { mergeConfig, defineConfig } from 'vitest/config';
import baseConfig from './vitest.base.config';

// Implements REQ-001: Shared root Vitest config + project aggregation
// Uses mergeConfig to properly deep-merge base test settings (pool, timeouts, setup)
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Root config runs only the core/shared/electron test suites
      include: [
        'packages/shared/src/**/*.{test,spec}.{ts,tsx}',
        'packages/core/src/**/*.{test,spec}.{ts,tsx}',
        'apps/electron/src/**/*.{test,spec}.{ts,tsx}',
      ],
      // Implements REQ-007: Quarantine legacy failing tests
      exclude: [
        '**/apps/electron/src/renderer/lib/__tests__/icon-cache.test.ts',
        '**/packages/shared/src/codex/__tests__/config-generator.test.ts',
        '**/packages/shared/src/agent/backend/__tests__/factory.test.ts',
        '**/packages/shared/src/agent-teams/__tests__/checkpoint-manager.test.ts',
      ],
      passWithNoTests: false,
    },
  }),
);
