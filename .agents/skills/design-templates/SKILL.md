---
name: design-templates
description: Design template library management skill. Use for browsing, applying, and managing saved design templates from previous design flow sessions.
---

## Purpose

Manage the workspace design template library created by the design flow (REQ-008).
Templates are reusable design starting points saved from previously approved design variants.

## Capabilities

1. **List templates** — Show all saved templates with name, direction, framework, and creation date
2. **View template** — Display a template's brief, component spec, and file listing
3. **Apply template** — Copy a template's files into the current project after compatibility check
4. **Delete template** — Remove a template from the workspace library
5. **Check compatibility** — Verify a template works with the current project's stack

## Template Structure

Templates are stored at `workspaces/{workspaceId}/design-templates/`:

```
design-templates/
  index.json              — Template index [{id, name, createdAt}]
  dt-{variantId}/
    template.json         — Full template data (brief, files, stack requirements)
```

## Compatibility Rules

A template is compatible when:
- Framework matches (or template uses `vanilla`)
- TypeScript requirement met (TS template requires TS project)
- Required dependencies are present in `package.json`

## Output Contract

### List Templates
```
| Name | Direction | Framework | Created |
| ---- | --------- | --------- | ------- |
| ...  | ...       | ...       | ...     |
```

### View Template
- **Name** and design direction
- **Brief** (markdown)
- **Component Spec** (markdown)
- **Files** (list with paths)
- **Stack Requirements** (framework, TS, deps)

### Apply Template
1. Run compatibility check
2. Copy template files to target directory
3. Report which files were created
4. Warn about any missing dependencies
