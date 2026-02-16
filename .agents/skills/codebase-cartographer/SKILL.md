---
name: codebase-cartographer
description: Codebase search and mapping skill. Use for quickly orienting in a repo, locating implementations, tracing call paths, identifying ownership boundaries, and summarizing “where to change what”.
---

## Workflow

1. **Map entry points**: app bootstrap, routing, DI/service registration
2. **Find the data path**: types → state/store → API client → server handlers
3. **Summarize**: 5–10 bullets with file paths and responsibilities

## Output contract

- “Where it lives”: file paths to touch
- “How it flows”: 3–6 step call/data path
- “Risk”: what could break + quick smoke tests

