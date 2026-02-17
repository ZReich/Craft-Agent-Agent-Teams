---
name: test-writer
description: Test authoring skill for agent teams. Use for creating or updating unit/integration/e2e tests, defining acceptance tests from requirements, and closing test coverage gaps before review.
---

## Test workflow

1. Map requirement IDs to concrete behaviors
2. Select smallest effective test pyramid slice
3. Write failing-first tests where feasible
4. Implement deterministic fixtures/mocks
5. Add regression test for each bug risk
6. Document what is covered vs intentionally out of scope

## Guardrails

- Prefer stable assertions over snapshot-heavy checks
- Avoid brittle timing-based assertions
- Include negative/error-path coverage
- Keep test names behavior-oriented

## Output contract

- Added/updated tests by file
- Requirement coverage map
- Known gaps and follow-ups
