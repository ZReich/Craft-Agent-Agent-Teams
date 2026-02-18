---
name: integration-fixer
description: Integration and wiring repair skill for agent teams. Use when code compiles in isolation but fails in end-to-end integration, import wiring, runtime composition, or cross-module contracts.
---

## Integration workflow

1. Reproduce integration failure signal (typecheck/test/runtime)
2. Trace contract boundaries (types, imports, events, APIs)
3. Fix minimal wiring/contract mismatch
4. Re-run focused then broader verification
5. Record root cause and prevention check

## Typical targets

- Missing imports/exports
- Interface drift between modules
- Event/schema mismatch
- Feature stitched but never invoked

## Output contract

- Root cause
- Files changed and why
- Verification run list
- Preventive test/check added
