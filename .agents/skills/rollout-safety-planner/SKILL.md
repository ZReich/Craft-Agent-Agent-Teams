---
name: rollout-safety-planner
description: Release safety planning skill. Use to define rollout stages, observability checks, rollback criteria, and incident-response guardrails for risky changes.
---

## Safety workflow

1. Identify risk surface and user impact radius
2. Define phased rollout and feature-flag strategy
3. Specify observability signals and alert thresholds
4. Document rollback triggers and operator runbook

## Output contract

- Rollout plan with phases and gates
- Observability plan (logs/metrics/alerts)
- Rollback plan with explicit trigger conditions

## Done means

- Launch/rollback decisions are objective
- Operators have actionable runbook steps
- Post-launch monitoring window is defined
