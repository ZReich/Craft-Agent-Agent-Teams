# Spec: Codex Agent Teams Test Mock Breakage Fix

**DRI:** Craft Agent (REQ-005, REQ-006)
**Status:** Draft
**Last Updated:** 2026-02-09

## Context

The `codex-agent-teams.test.ts` file was migrated from Bun to Vitest and now includes a mock for `mode-manager.ts` to work around Node 22 CJS/ESM interop issues with the `incr-regex-package` transitive dependency. Additionally, recent changes to `codex-agent.ts` introduce new imports (`PromptBuilder`, `AgentEventUsage`, pricing utilities) that may require additional mocking.

## Requirements Summary

- **REQ-005:** Fix test mock configuration to handle all transitive dependencies
- **REQ-006:** Ensure test suite passes with isolated mocks (no side effects from real implementations)

---

## Risks (REQ-005, REQ-006)

### Technical Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **Incomplete mock coverage** | Tests fail due to unmocked dependencies (PromptBuilder, pricing, config-generator) | HIGH | Audit all imports in codex-agent.ts; mock all modules with heavy transitive deps |
| **Mock drift from real implementation** | Tests pass but don't reflect actual behavior; false positives | MEDIUM | Document mock assumptions; add integration tests that use real implementations |
| **CJS/ESM interop brittleness** | Different behavior between Node versions (22 vs 20) | MEDIUM | Pin Node version in CI; document ESM compatibility requirements |
| **Test isolation failure** | Side effects from real module imports leak between tests | MEDIUM | Use `vi.resetModules()` in `beforeEach`; verify no shared state |
| **Over-mocking critical logic** | Mocking too much of codex-agent internals hides bugs | LOW | Keep mocks minimal (only external deps); test real agent methods |

### Operational Risks

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| **False confidence in test suite** | Merging broken code due to test blind spots | MEDIUM | Run tests in CI with multiple Node versions; manual QA for agent teams |
| **Developer experience degradation** | Flaky tests slow down development | LOW | Document test setup; provide clear error messages when mocks fail |

### Dependencies at Risk

- **mode-manager.ts** → `incr-regex-package` (CJS/ESM issue)
- **PromptBuilder** → `config-generator.ts` → multiple config modules
- **pricing.ts** → model registry, cost calculations
- **Workspace/Session types** → file system operations

---

## Rollout/Rollback Plan (REQ-005, REQ-006)

### Rollout Strategy

**Phase 1: Diagnostic** (5 min)
1. Run test suite with verbose output: `npm test -- packages/shared/src/agent/__tests__/codex-agent-teams.test.ts --reporter=verbose`
2. Capture stack traces for all failing assertions
3. Identify unmocked modules causing failures

**Phase 2: Incremental Mocking** (15 min)
1. Add mocks for identified dependencies (PromptBuilder, pricing, config modules)
2. Run tests after each mock addition to verify fix
3. Use minimal mock implementations (return hardcoded values, avoid logic)

**Phase 3: Validation** (10 min)
1. Run full test suite: `npm test`
2. Verify no test pollution (run tests in isolation: `npm test -- --isolate`)
3. Check for mock leakage between test cases

**Phase 4: Documentation** (5 min)
1. Add inline comments explaining each mock's purpose
2. Document ESM interop issues in test file header
3. Update package.json scripts if needed (Node version, flags)

### Rollback Plan

**Trigger:** Tests still fail after 30 minutes of debugging OR mocks become unmaintainable

**Rollback Steps:**
1. Revert test file to previous working state (before Vitest migration)
2. Re-enable Bun test runner for this specific test file
3. Document Bun-specific test in `vitest.config.ts` exclusions
4. Create follow-up issue: "Migrate codex-agent-teams.test.ts to Vitest"

**Rollback Validation:**
- Tests pass with Bun: `bun test packages/shared/src/agent/__tests__/codex-agent-teams.test.ts`
- No CI failures related to this test file

---

## Monitoring & Validation Checklist (REQ-005, REQ-006)

### Pre-Fix Validation
- [ ] Capture baseline: current test failure count and error messages
- [ ] Verify test failures are mock-related (not logic bugs in codex-agent.ts)
- [ ] Check if any tests pass (identify working subset)

### During Fix
- [ ] Each mock addition reduces test failures (incremental progress)
- [ ] No new errors introduced (watch for cascading failures)
- [ ] Mock implementations are minimal (no business logic)

### Post-Fix Validation

#### Test Health
- [ ] All 13 test cases pass: `npm test -- codex-agent-teams.test.ts`
- [ ] No console warnings about unmocked modules
- [ ] Test runtime < 5 seconds (mocks should be fast)
- [ ] Tests pass in isolation: `npm test -- --isolate`

#### Coverage & Correctness
- [ ] Code coverage for agent teams interception > 90%
- [ ] Mock assumptions documented in test file header
- [ ] Each mock has a comment explaining WHY it's needed (e.g., "CJS/ESM issue")

#### Integration Safety
- [ ] Run integration test with real CodexAgent (if available)
- [ ] Manual QA: spawn teammate in Craft Agent app, verify no regressions
- [ ] Check for mock drift: compare mock signatures to real module exports

#### CI/CD
- [ ] Tests pass in GitHub Actions (Linux + Node 22)
- [ ] Tests pass on local Windows (current environment)
- [ ] No flakiness: run test suite 5 times consecutively

### Success Criteria
✅ **REQ-005:** All tests pass with isolated mocks, no transitive dependency errors
✅ **REQ-006:** Test suite runs reliably in CI, no mock drift warnings

### Failure Indicators
🚨 **Abort if:**
- Mocks require >100 lines of setup (over-mocking)
- Tests become flaky (pass/fail inconsistently)
- Mock implementations duplicate business logic (defeating the purpose)

---

## Next Steps (Post-Fix)

1. **REQ-007 (Future):** Add integration tests using real CodexAgent (not just mocks)
2. **REQ-008 (Future):** Migrate incr-regex-package to ESM or replace with ESM-compatible alternative
3. **Documentation:** Update testing guide with ESM mocking patterns

---

## Appendix: Mock Inventory

### Current Mocks
```typescript
vi.mock('../mode-manager.ts', () => ({
  shouldAllowToolInMode: (_tool, _input, mode) => mode === 'allow-all' ? { allowed: true } : { allowed: false, reason: 'Blocked' },
  PERMISSION_MODE_ORDER: ['safe', 'ask', 'allow-all'],
  PERMISSION_MODE_CONFIG: {},
  SAFE_MODE_CONFIG: {},
}));
```

### Potentially Needed Mocks (REQ-005)
- **PromptBuilder** → Mock constructor and methods
- **config-generator.ts** → Mock `generateAgentTeamsPromptSection`
- **pricing.ts** → Mock `calculateTokenCostUsd`, `inferProviderFromModel`
- **models.ts** → Mock `getModelById`, `getModelIdByShortName`

### Mock Strategy
- **External modules:** Mock fully (file system, network, process spawning)
- **Type-only imports:** No mocking needed
- **Business logic:** Use real implementations when possible (only mock if CJS/ESM issue)
