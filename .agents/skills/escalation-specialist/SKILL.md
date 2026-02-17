---
name: escalation-specialist
description: Escalation handling skill for agent teams. Use when quality gates fail repeatedly, blockers are cross-domain, risks are high-severity, or a decisive recovery/rollback path is needed.
---

## Escalation workflow

1. Classify severity (blocker, critical risk, compliance risk, unknown)
2. Collect evidence (failing checks, impacted requirements, owner/DRI, affected files)
3. Choose escalation action:
   - unblock with explicit decision
   - split task and reassign DRIs
   - trigger rollback/safe fallback
4. Produce a single escalation handoff message with:
   - decision
   - rationale
   - immediate next actions
   - exit criteria

## Output contract

- Severity and reason
- Decision (continue / pause / rollback / re-scope)
- Task-level next actions with owners
- Rollout/rollback note
