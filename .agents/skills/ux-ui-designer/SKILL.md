---
name: ux-ui-designer
description: UX and UI design specialist skill. Use for user flows, wireframes, interaction design, information architecture, accessibility (a11y), design-system specs, and UI component specification work.
---

## Output contract

Produce **(1) a flow**, **(2) screens**, and **(3) component specs**:

1. **User flow**
   - Actors, entry points, happy path, error states
   - Key decisions (what the UI should do and why)
2. **Screen / state list**
   - Screen/state name → purpose → required data → primary actions
3. **Component spec**
   - Component list with props/state/events
   - A11y: focus order, keyboard interactions, labels/roles, contrast notes

## Design checklist

- Prefer fewer screens; avoid modal chains
- Every async action has: loading + success + failure + retry
- A11y: keyboard-first path works; no “hover-only” meaning
- Provide acceptance criteria the engineer can implement + test

## Design Variant Generation (REQ-004)

When operating as **Head-UX** in the design flow, produce **N design variants** with distinct design directions:

### Head-UX Responsibilities

1. **Receive** `ProjectStack` context (framework, component inventory, design tokens, animation library)
2. **Create N creative briefs** with different design directions:
   - **Minimal** — Clean, spacious, content-focused, subtle animations
   - **Data-Dense** — Information-rich, dashboards, compact layout, utility-first
   - **Expressive** — Bold typography, dramatic animations, creative layout, hero sections
   - **Conventional** — Familiar patterns, standard navigation, predictable UX, accessibility-first
3. **Fan out** briefs to Worker agents, each producing a variant
4. **Collect** variant outputs and validate they compile against the project's stack
5. **Package** variants for presentation in the design grid

### Worker Output Contract (per variant)

Each Worker receives a brief + stack context and must produce:

- `.tsx`/`.vue`/`.svelte` files using the project's actual component imports
- `brief.md` — Design approach description
- `components.md` — Component spec with props/state/events

**Critical:** Workers must import from the project's real components (e.g., `import { Button } from '@/components/ui/button'`), use the project's Tailwind config tokens, and use the project's animation library.

### Design Direction Briefs

Each brief includes:
- Direction name and philosophy
- Target layout approach (grid, single-column, sidebar, etc.)
- Color usage guidance (from Tailwind config)
- Animation style (from detected animation library)
- Component selection (from inventory)
- Mobile responsiveness approach

## Templates

### User flow (copy/paste)
- Goal:
- Preconditions:
- Steps:
- Error/edge cases:
- Success definition:

### Component spec (copy/paste)
- Name:
- Purpose:
- Props:
- Events:
- States:
- A11y:

