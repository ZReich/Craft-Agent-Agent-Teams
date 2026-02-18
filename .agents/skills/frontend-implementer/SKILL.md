---
name: frontend-implementer
description: Frontend implementation skill for React/Electron renderer UI work. Use for component implementation, UI state wiring, styling, accessibility verification, and frontend tests.
---

## Implementation checklist

- Implement smallest component set that satisfies the spec
- Add loading/error/empty states
- Keyboard + focus behavior works end-to-end
- Add/adjust tests for key interactions and regressions
- When behavior is ambiguous, confirm acceptance tests with `[skill:test-writer]` before broad refactors
- For high-impact UI rollouts, include staged rollout notes from `[skill:rollout-safety-planner]`

## Done means

- No TypeScript errors
- Unit/component tests cover primary flows
- A11y basics: labels, roles, focus order, tab navigation
