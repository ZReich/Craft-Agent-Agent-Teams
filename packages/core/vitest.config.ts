import { defineConfig, mergeConfig } from 'vitest/config';
import baseConfig from '../../vitest.base.config';

// Implements REQ-001: Per-project Vitest config for @craft-agent/core
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
      passWithNoTests: false,
    },
  }),
);
