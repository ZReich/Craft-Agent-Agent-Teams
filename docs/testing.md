# Testing Guide

// Implements REQ-004: Testing documentation

## Where Tests Live
- `packages/shared/src/**/__tests__/*.test.ts`
- `packages/core/src/**/__tests__/*.test.ts`
- `apps/electron/src/**/__tests__/*.test.ts`

## How to Run
- Root (all projects): `bun run test`
- Shared: `cd packages/shared && bun run test`
- Core: `cd packages/core && bun run test`
- Electron: `cd apps/electron && bun run test`

## Standards
- All new features must include unit tests.
- Missing tests fail the quality gate (no test files = fail).
- Integration must be verified; unintegrated code fails the gate.
- Legacy failing tests are quarantined from default runs (see vitest.config.ts exclude list).
