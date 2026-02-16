---
name: quality-reviewer
description: Reviewer/QA skill for agent team outputs. Use for code review, SDD traceability checks (REQ↔code↔tests), acceptance test verification, and rollout/rollback safety review.
---

## Review checklist

- Spec compliance: requirements are covered; acceptance tests updated
- Traceability: changes reference REQ-IDs where applicable
- Tests: added/updated; failures explained
- Risk: rollout/rollback plan noted for risky changes

## Output format

- Verdict: approve / request changes / escalate
- Findings: bullets grouped by severity (blocking / non-blocking)
- Next actions: concrete fixes with file hints

