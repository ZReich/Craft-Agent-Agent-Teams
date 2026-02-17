/**
 * Design Generator
 *
 * Orchestrates the Head-UX → Worker fan-out for generating design variants.
 * Provides prompt templates that inject ProjectStack context so Workers
 * produce stack-native code using the project's actual components.
 *
 * Implements REQ-004: Design Variant Generation Pipeline
 */

import { randomUUID } from 'crypto';
import type {
  ProjectStack,
  DesignVariant,
  DesignVariantStatus,
  Spec,
} from '@craft-agent/core/types';

// ============================================================
// Design Directions
// ============================================================

export interface DesignDirection {
  name: string;
  philosophy: string;
  layoutApproach: string;
  animationStyle: string;
  colorUsage: string;
}

/**
 * Default design directions. Head-UX generates one brief per direction.
 * The number of directions used equals `variantsPerRound`.
 */
export const DEFAULT_DIRECTIONS: DesignDirection[] = [
  {
    name: 'Minimal',
    philosophy: 'Clean, spacious, content-focused. Let the content breathe with generous whitespace and subtle interactions.',
    layoutApproach: 'Single-column or asymmetric grid. Large type, minimal navigation chrome.',
    animationStyle: 'Subtle fade-ins, gentle scale transitions, micro-interactions on hover.',
    colorUsage: 'Monochromatic or limited palette. Use accent color sparingly for CTAs.',
  },
  {
    name: 'Data-Dense',
    philosophy: 'Information-rich, utility-first. Pack maximum value into every pixel without feeling cluttered.',
    layoutApproach: 'Multi-column dashboard grid. Sidebar navigation, card-based content areas.',
    animationStyle: 'Functional transitions only — loading states, data updates, sort/filter feedback.',
    colorUsage: 'Semantic colors for status/priority. Muted backgrounds, vivid data highlights.',
  },
  {
    name: 'Expressive',
    philosophy: 'Bold, creative, memorable. Make a statement with dramatic visuals and playful interactions.',
    layoutApproach: 'Hero sections, overlapping elements, asymmetric grids, full-bleed images.',
    animationStyle: 'Dramatic entrances (spring physics), parallax, scroll-triggered animations, hover reveals.',
    colorUsage: 'High contrast, gradient accents, vibrant palette. Color as a design element, not just decoration.',
  },
  {
    name: 'Conventional',
    philosophy: 'Familiar patterns, predictable UX. Users should never feel lost. Accessibility-first design.',
    layoutApproach: 'Standard header/sidebar/content. Breadcrumbs, clear hierarchy, consistent spacing.',
    animationStyle: 'Standard transitions (200-300ms ease). Focus rings, loading spinners, toast notifications.',
    colorUsage: 'Standard semantic colors. WCAG AA contrast everywhere. Clear visual hierarchy via shade.',
  },
  {
    name: 'Editorial',
    philosophy: 'Magazine-inspired, narrative-driven. Content as story, with strong visual rhythm.',
    layoutApproach: 'Full-width hero, alternating content/image blocks, pull quotes, feature grids.',
    animationStyle: 'Scroll-reveal, text animations, image fade-ins, content choreography.',
    colorUsage: 'Elegant, restrained palette. Strong typography as color. Occasional accent pops.',
  },
  {
    name: 'Playful',
    philosophy: 'Fun, approachable, delightful. Surprise the user with personality and whimsy.',
    layoutApproach: 'Rounded containers, floating elements, sticker-like badges, emoji integration.',
    animationStyle: 'Bouncy springs, wiggle on hover, confetti, path animations, drag interactions.',
    colorUsage: 'Warm, saturated palette. Gradients, illustrated backgrounds, icon-heavy.',
  },
];

// ============================================================
// Prompt Templates
// ============================================================

/**
 * Generate the Head-UX prompt for creating design briefs.
 * The Head-UX agent receives this as its task instructions.
 */
export function buildHeadUXPrompt(
  stack: ProjectStack,
  spec: Spec,
  directions: DesignDirection[],
): string {
  const componentList = stack.components.length > 0
    ? stack.components.map(c => `- \`${c.name}\` (${c.path})`).join('\n')
    : '- No components detected — create from scratch';

  const tailwindInfo = stack.styling.tailwind && stack.styling.tailwindConfig
    ? `Tailwind is configured. Design tokens available in: ${(stack.styling.tailwindConfig as Record<string, unknown>)._file ?? 'tailwind.config.js'}`
    : stack.styling.tailwind
      ? 'Tailwind CSS is available (default config)'
      : 'No Tailwind — use standard CSS';

  const animationInfo = stack.animationLibrary
    ? `Animation library: \`${stack.animationLibrary}\` — use its API for all animations`
    : 'No animation library detected — use CSS transitions/animations';

  return `You are the Head-UX design lead. Your job is to create ${directions.length} distinct design briefs for the feature described in the spec.

## Project Stack
- **Framework:** ${stack.framework ?? 'unknown'}${stack.nextjsRouter ? ` (${stack.nextjsRouter} router)` : ''}
- **TypeScript:** ${stack.typescript ? 'Yes' : 'No'}
- **UI Library:** ${stack.uiLibrary ?? 'none'}
- **Styling:** ${tailwindInfo}
- **Animation:** ${animationInfo}

## Available Components
${componentList}

## Existing Patterns
- Layouts: ${stack.patterns.layouts.join(', ') || 'none'}
- Pages: ${stack.patterns.pages.join(', ') || 'none'}
- Hooks: ${stack.patterns.hooks.join(', ') || 'none'}

## Spec Summary
**Title:** ${spec.title}
**Goals:** ${spec.goals?.join('; ') ?? 'Not specified'}
**Requirements:**
${spec.requirements.map(r => `- ${r.id}: ${r.description}`).join('\n')}

## Design Directions
Create one brief per direction:
${directions.map((d, i) => `
### Direction ${i + 1}: ${d.name}
- Philosophy: ${d.philosophy}
- Layout: ${d.layoutApproach}
- Animation: ${d.animationStyle}
- Color: ${d.colorUsage}
`).join('\n')}

## Output Format
For each direction, produce a brief with:
1. Direction name
2. Layout description (specific to this feature, not generic)
3. Key screens/states
4. Component usage plan (which existing components to use, what new ones to create)
5. Animation plan (specific animations, not generic)
6. Responsive strategy
`;
}

/**
 * Generate the Worker prompt for producing a single design variant.
 * Each Worker receives this along with its specific brief from Head-UX.
 */
export function buildWorkerDesignPrompt(
  stack: ProjectStack,
  direction: DesignDirection,
  brief: string,
  targetScreens: string[],
): string {
  const ext = getFileExtension(stack);
  const importStyle = getImportStyle(stack);

  return `You are a design Worker. Produce a complete, compilable ${ext} implementation for the "${direction.name}" design direction.

## CRITICAL RULES
1. **Use the project's actual imports** — ${importStyle}
2. **Use the project's styling** — ${stack.styling.tailwind ? 'Tailwind classes from the project config' : 'CSS modules or styled-components as used in the project'}
3. **Use the project's animation library** — ${stack.animationLibrary ? `\`${stack.animationLibrary}\` API` : 'CSS transitions only'}
4. **TypeScript** — ${stack.typescript ? 'All files must be .tsx with proper types' : 'Use .jsx'}
5. **Export a default component** — The main page component must be the default export

## Design Brief
${brief}

## Target Screens
${targetScreens.map(s => `- ${s}`).join('\n')}

## Output Files
Produce these files:
1. \`page.${ext}\` — Main page component (default export)
2. Any additional component files needed
3. \`brief.md\` — Your design approach description (2-3 paragraphs)
4. \`components.md\` — Component spec with props/state/events

## Available Components to Import
${stack.components.map(c => `- \`import { ${c.name} } from '${getComponentImportPath(c.path)}'\``).join('\n') || '- Create all components from scratch'}

## Animation Patterns
${stack.animationLibrary === 'framer-motion' ? `Use \`motion\` components and \`AnimatePresence\` for enter/exit animations.` :
  stack.animationLibrary === 'react-spring' ? `Use \`useSpring\`, \`useTransition\`, \`animated\` components.` :
  stack.animationLibrary === 'gsap' ? `Use \`gsap.to()\`, \`gsap.from()\`, \`ScrollTrigger\` for scroll animations.` :
  stack.animationLibrary === 'motion' ? `Use the \`motion\` API for animations.` :
  `Use CSS \`transition\` and \`@keyframes\` animations.`}
`;
}

// ============================================================
// Variant Factory
// ============================================================

/**
 * Create an empty DesignVariant shell for a given direction.
 * Workers will populate the files, brief, and componentSpec.
 */
export function createVariantShell(
  direction: DesignDirection,
  round: number,
): DesignVariant {
  return {
    id: `dv-${randomUUID().slice(0, 8)}`,
    name: direction.name,
    direction: direction.philosophy,
    status: 'generating' as DesignVariantStatus,
    files: [],
    brief: '',
    componentSpec: '',
    previewUrl: null,
    error: null,
    round,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Select N directions for a generation round.
 * Round 1 uses the first N default directions;
 * subsequent rounds rotate through remaining directions.
 */
export function selectDirections(count: number, round: number): DesignDirection[] {
  const startIndex = ((round - 1) * count) % DEFAULT_DIRECTIONS.length;
  const directions: DesignDirection[] = [];
  for (let i = 0; i < count; i++) {
    directions.push(DEFAULT_DIRECTIONS[(startIndex + i) % DEFAULT_DIRECTIONS.length]!);
  }
  return directions;
}

// ============================================================
// Helpers
// ============================================================

function getFileExtension(stack: ProjectStack): string {
  if (stack.framework === 'vue') return 'vue';
  if (stack.framework === 'svelte') return 'svelte';
  return stack.typescript ? 'tsx' : 'jsx';
}

function getImportStyle(stack: ProjectStack): string {
  if (stack.uiLibrary === 'shadcn') return '`import { Button } from "@/components/ui/button"` etc.';
  if (stack.uiLibrary === 'mui') return '`import { Button } from "@mui/material"` etc.';
  if (stack.uiLibrary === 'mantine') return '`import { Button } from "@mantine/core"` etc.';
  if (stack.uiLibrary === 'chakra') return '`import { Button } from "@chakra-ui/react"` etc.';
  return 'standard relative imports from the component directory';
}

function getComponentImportPath(filePath: string): string {
  // Convert src/components/ui/Button.tsx → @/components/ui/Button
  return filePath
    .replace(/^src\//, '@/')
    .replace(/\.[^.]+$/, '');
}
