---
name: quality-reviewer
description: Reviewer/QA skill for agent team outputs. Use for code review, SDD traceability checks (REQ↔code↔tests), acceptance test verification, rollout/rollback safety review, and validation of routing/skill-pack changes.
---

## Review checklist

- Spec compliance: requirements are covered; acceptance tests updated
- Traceability: changes reference REQ-IDs where applicable
- Tests: added/updated; failures explained
- Routing/policy: domain -> role -> skill mapping changes are deterministic and tested
- Risk: rollout/rollback plan noted for risky changes

## Output format

- Verdict: approve / request changes / escalate
- Findings: bullets grouped by severity (blocking / non-blocking)
- Next actions: concrete fixes with file hints
