---
name: task-router
description: Task routing skill for agent teams. Use to classify work (ux/design, frontend, backend, research/search, review) and pick the correct teammate role/model and skill pack with guardrails (UX/design must be top-tier).
---

## Routing rules (summary)

- **UX/Design** → Head + **Opus** + `[skill:ux-ui-designer]` (hard enforced)
- **Frontend** → Worker + `[skill:frontend-implementer]`
- **Backend** → Worker + `[skill:backend-implementer]`
- **Search/Research** → Worker + `[skill:codebase-cartographer]`
- **Review/QA** → Reviewer + `[skill:quality-reviewer]`

## Output

Return:
- domain
- teammate role
- model tier note (enforced or default)
- skill slugs to mention

