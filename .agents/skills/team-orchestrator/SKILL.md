---
name: team-orchestrator
description: Team lead orchestration skill. Use to run the spec -> tasks -> assignment -> review -> synthesis loop with SDD traceability (REQ-IDs, DRIs, acceptance tests) and safety (rollout/rollback).
---

## Lead workflow

1. Confirm/produce spec requirements + acceptance tests
2. Decompose into tasks; attach requirementIds + DRI owner/reviewer
3. Route tasks to specialists (use `[skill:task-router]` rules)
4. Ensure test and integration ownership is explicit for implementation work
5. Collect results; run review/QA; escalate blockers when needed
6. Synthesize: update spec coverage + summarize changes + rollout/rollback readiness

## Guardrails

- Never assign UX/Design to worker-tier
- Block task completion if acceptance tests are missing for new requirements
- For repeated failed review cycles, route to `[skill:escalation-specialist]` with explicit decision options
- Require completion handoff messages to include REQ coverage and verification evidence
