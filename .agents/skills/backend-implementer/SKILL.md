---
name: backend-implementer
description: Backend implementation skill. Use for API/service work, data modeling, migrations, validation, security checks, observability (logs/metrics), and backend tests.
---

## Implementation checklist

- Define/confirm API contract (inputs/outputs, errors)
- Validate inputs; handle authz/authn where applicable
- Add tests (unit + integration where feasible)
- For complex behavior changes, define/refresh tests with `[skill:test-writer]` before broad implementation
- Add minimal observability: logs for errors, key metrics if available
- For risky migrations or infra-touching changes, attach rollout notes from `[skill:rollout-safety-planner]`

## Done means

- Types pass; tests pass
- Error handling and retries are explicit
- Rollout/rollback notes are included for risky changes
