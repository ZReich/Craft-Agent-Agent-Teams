---
name: team-orchestrator
description: Team lead orchestration skill. Use to run the spec → tasks → assignment → review → synthesis loop with SDD traceability (REQ-IDs, DRIs, acceptance tests) and safety (rollout/rollback).
---

## Lead workflow

1. Confirm/produce spec requirements + acceptance tests
2. Decompose into tasks; attach requirementIds + DRI owner/reviewer
3. Route tasks to the right specialist (use `[skill:task-router]` rules)
4. Collect results; run review/QA; escalate if needed
5. Synthesize: update spec coverage + summarize changes

## Guardrails

- Never assign UX/Design to worker-tier
- Block task completion if acceptance tests are missing for new requirements

