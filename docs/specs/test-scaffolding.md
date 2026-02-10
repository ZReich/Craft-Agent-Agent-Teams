# Test Scaffolding for Monorepo

**DRI:** Craft Agent  
**Date:** 2026-02-09  

## Goals
- Establish per-project test scaffolding across the monorepo.
- Enforce test execution as a hard gate for new features and changes.
- Provide a unified, best-practice Vitest setup for all projects.

## Non-Goals
- Writing full test coverage for existing features.
- Adding E2E/UI automation beyond a minimal scaffold (unless requested).

## Requirements
- **REQ-001 (High):** Provide a shared Vitest base config and per-project Vitest configs.
- **REQ-002 (High):** Add minimal smoke tests in each project to ensure the runner works.
- **REQ-003 (High):** Add per-project test scripts (and root runner) for consistent usage.
- **REQ-004 (Medium):** Provide documentation on where tests live and how to run them.
- **REQ-005 (High):** Fail the quality gate when no test files are found.
- **REQ-006 (High):** Enforce integration verification; unintegrated code must fail the gate.
- **REQ-007 (Medium):** Quarantine legacy failing tests so strict gating applies only to new features.

## Acceptance Tests
- Root: `bun run test` runs all project tests.
- Shared: `cd packages/shared && bun run test` passes.
- Core: `cd packages/core && bun run test` passes.
- Electron: `cd apps/electron && bun run test` passes.
- Quarantined legacy tests are excluded from default runs.

## Risks
- Some projects may require additional mocks as tests expand.
- Developers may need to add tests before feature work to satisfy the gate.

## Rollout Plan
1. Add configs + smoke tests.
2. Verify tests run in all projects.
3. Keep gate strict for new changes.

## Rollback Plan
- Remove Vitest configs and scripts if needed.
- Revert quality gate enforcement for tests.
