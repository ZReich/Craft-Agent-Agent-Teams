---
name: task-router
description: Task routing skill for agent teams. Use to classify work (ux/design, frontend, backend, research/search, review, testing, integration, planning, docs, remediation, and escalation) and pick the correct teammate role/model and skill pack with guardrails (UX/design must be top-tier).
---

## Routing rules (summary)

- **UX/Design** -> Head + **Opus** + `[skill:ux-ui-designer]` (hard enforced)
- **Frontend** -> Worker + `[skill:frontend-implementer]`
- **Backend** -> Worker + `[skill:backend-implementer]`
- **Search/Research** -> Worker + `[skill:codebase-cartographer]`
- **Review/QA** -> Reviewer + `[skill:quality-reviewer]`
- **Test-focused coding** -> Worker + `[skill:test-writer]`
- **Integration break/fix** -> Worker + `[skill:integration-fixer]`
- **Planning/Spec** -> Worker + `[skill:spec-planner]`
- **Docs maintenance** -> Worker + `[skill:docs-maintainer]`
- **Review remediation loops** -> Worker + `[skill:remediation-coordinator]`
- **Risky rollout/release work** -> Reviewer + `[skill:rollout-safety-planner]`
- **Escalation diagnosis** -> Escalation + `[skill:escalation-specialist]`

## Output

Return:
- domain
- teammate role
- model tier note (enforced or default)
- skill slugs to mention

## Guardrails

- Keep skill packs minimal (prefer one primary skill unless explicitly multi-domain).
- If prompt indicates critical risk or repeated failed cycles, route to escalation specialist.
