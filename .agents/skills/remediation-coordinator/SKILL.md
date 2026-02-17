---
name: remediation-coordinator
description: Quality-gate remediation planning skill. Use to translate review failures into minimal fix tasks with ordering, ownership, and verification steps.
---

## Remediation workflow

1. Parse failures into blocking vs non-blocking issues
2. Group issues by root cause and dependency order
3. Create smallest fix tasks with requirement/test links
4. Define re-check sequence and completion criteria

## Output contract

- Remediation task list (ordered)
- Each task includes owner, scope, and validation step
- Retry strategy for next review cycle

## Done means

- Blocking failures are mapped to concrete tasks
- Task order avoids rework loops
- Next review has clear pass criteria
