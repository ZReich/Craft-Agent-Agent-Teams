/**
 * Design Store
 *
 * Handles design artifact lifecycle:
 * - Selection: Move selected variant files to final project location
 * - Cleanup: Remove non-selected variants and preview scaffolding
 * - Session storage: Persist design metadata per session
 * - Template library: Save/load reusable design templates per workspace
 *
 * Implements REQ-007: Design Selection → Implementation Handoff
 * Implements REQ-008: Design Artifact Storage
 */

import { readFile, writeFile, mkdir, rm, rename, copyFile } from 'fs/promises';
import { join, dirname } from 'path';
import type {
  DesignVariant,
  DesignArtifact,
  DesignMetadata,
  DesignTemplate,
  ProjectStack,
} from '@craft-agent/core/types';
import { cleanupPreviewRoutes } from './preview-scaffold';

// ============================================================
// Selection & Handoff (REQ-007)
// ============================================================

export interface SelectionResult {
  /** The design artifact ready for spec attachment */
  artifact: DesignArtifact;
  /** Final file paths in the project */
  movedFiles: string[];
}

/**
 * Handle design selection: move selected variant files to the target
 * project location, clean up non-selected variants, and return an
 * artifact for spec attachment.
 */
export async function selectAndHandoff(
  projectDir: string,
  variants: DesignVariant[],
  selectedVariantId: string,
  targetDir: string,
  stack: ProjectStack,
  scaffoldedFiles: string[],
): Promise<SelectionResult> {
  const selected = variants.find(v => v.id === selectedVariantId);
  if (!selected) {
    throw new Error(`Selected variant ${selectedVariantId} not found`);
  }

  // Move selected variant files to target location
  const movedFiles: string[] = [];
  const sourceDir = join(projectDir, 'design-preview', `variant-${selected.id}`);

  for (const file of selected.files) {
    const src = join(sourceDir, file.path);
    const dest = join(projectDir, targetDir, file.path);
    await mkdirSafe(dirname(dest));
    try {
      await rename(src, dest);
    } catch {
      // Cross-device rename fails — fall back to copy+delete
      await copyFile(src, dest);
      await rm(src, { force: true });
    }
    movedFiles.push(join(targetDir, file.path));
  }

  // Clean up all preview files
  await cleanupPreviewRoutes(projectDir, scaffoldedFiles);

  // Build design artifact for spec attachment
  const artifact: DesignArtifact = {
    selectedVariantId: selected.id,
    selectedVariantName: selected.name,
    brief: selected.brief,
    componentSpec: selected.componentSpec,
    filePaths: movedFiles,
    projectStack: stack,
    selectedAt: new Date().toISOString(),
  };

  return { artifact, movedFiles };
}

/**
 * Generate a prompt injection for frontend Workers to preserve the design.
 * This is appended to the Worker's task description when a design has been selected.
 *
 * Implements REQ-007: Frontend Worker prompt injection
 */
export function buildDesignPreservationPrompt(artifact: DesignArtifact): string {
  return `
## Design Approved — Implementation Constraints

A design has been approved for this feature. You MUST follow these constraints:

1. **DO NOT change the visual structure** — The layout, spacing, component hierarchy, and visual design are APPROVED
2. **Wire up data and functionality** — Connect props to real data, add event handlers, integrate with APIs
3. **Preserve all animations** — Keep all motion/transition code as-is
4. **Follow the component spec** — See approved component specification below

### Selected Design: ${artifact.selectedVariantName}

### Design Brief
${artifact.brief}

### Component Spec
${artifact.componentSpec}

### Design Files
${artifact.filePaths.map(f => `- \`${f}\``).join('\n')}
`;
}

// ============================================================
// Session Storage (REQ-008)
// ============================================================

/**
 * Save design metadata for a session.
 * Written to `{sessionDir}/designs/metadata.json`.
 */
export async function saveDesignMetadata(
  sessionDir: string,
  metadata: DesignMetadata,
): Promise<void> {
  const designsDir = join(sessionDir, 'designs');
  await mkdirSafe(designsDir);
  await writeFile(
    join(designsDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2),
    'utf-8',
  );
}

/**
 * Load design metadata for a session.
 * Returns null if no design metadata exists.
 */
export async function loadDesignMetadata(
  sessionDir: string,
): Promise<DesignMetadata | null> {
  try {
    const raw = await readFile(join(sessionDir, 'designs', 'metadata.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Create initial design metadata for a new design flow run.
 */
export function createDesignMetadata(
  sessionId: string,
  teamId: string,
  stack: ProjectStack,
): DesignMetadata {
  return {
    sessionId,
    teamId,
    variants: [],
    currentRound: 0,
    selectedVariantId: null,
    projectStack: stack,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ============================================================
// Template Library (REQ-008)
// ============================================================

const TEMPLATES_DIR = 'design-templates';
const TEMPLATES_INDEX = 'index.json';

/**
 * Save a selected design as a reusable workspace template.
 */
export async function saveDesignTemplate(
  workspaceDir: string,
  variant: DesignVariant,
  stack: ProjectStack,
  sessionId: string,
  teamId: string,
): Promise<DesignTemplate> {
  const template: DesignTemplate = {
    id: `dt-${variant.id}`,
    name: `${variant.name} — ${new Date().toLocaleDateString()}`,
    description: variant.direction,
    sourceVariantId: variant.id,
    direction: variant.direction,
    brief: variant.brief,
    componentSpec: variant.componentSpec,
    files: variant.files,
    stackRequirements: {
      framework: stack.framework,
      typescript: stack.typescript,
      requiredDeps: Object.keys(stack.dependencies).filter(d =>
        // Only include direct UI/framework deps, not all dependencies
        ['react', 'next', 'vue', 'svelte', 'tailwindcss', 'framer-motion', 'react-spring', 'gsap'].includes(d)
      ),
    },
    createdAt: new Date().toISOString(),
    sourceSessionId: sessionId,
    sourceTeamId: teamId,
  };

  // Write template files
  const templateDir = join(workspaceDir, TEMPLATES_DIR, template.id);
  await mkdirSafe(templateDir);
  await writeFile(
    join(templateDir, 'template.json'),
    JSON.stringify(template, null, 2),
    'utf-8',
  );

  // Update index
  const index = await loadTemplateIndex(workspaceDir);
  index.push({ id: template.id, name: template.name, createdAt: template.createdAt });
  await writeFile(
    join(workspaceDir, TEMPLATES_DIR, TEMPLATES_INDEX),
    JSON.stringify(index, null, 2),
    'utf-8',
  );

  return template;
}

/**
 * Load a specific design template.
 */
export async function loadDesignTemplate(
  workspaceDir: string,
  templateId: string,
): Promise<DesignTemplate | null> {
  try {
    const raw = await readFile(
      join(workspaceDir, TEMPLATES_DIR, templateId, 'template.json'),
      'utf-8',
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List all design templates in a workspace.
 */
export async function listDesignTemplates(
  workspaceDir: string,
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  return loadTemplateIndex(workspaceDir);
}

/**
 * Delete a design template.
 */
export async function deleteDesignTemplate(
  workspaceDir: string,
  templateId: string,
): Promise<void> {
  // Remove template directory
  await rm(join(workspaceDir, TEMPLATES_DIR, templateId), { recursive: true, force: true });

  // Update index
  const index = await loadTemplateIndex(workspaceDir);
  const filtered = index.filter(t => t.id !== templateId);
  await writeFile(
    join(workspaceDir, TEMPLATES_DIR, TEMPLATES_INDEX),
    JSON.stringify(filtered, null, 2),
    'utf-8',
  );
}

/**
 * Check if a template is compatible with the current project stack.
 */
export function isTemplateCompatible(
  template: DesignTemplate,
  currentStack: ProjectStack,
): boolean {
  // Framework must match (or template uses vanilla)
  if (template.stackRequirements.framework &&
      template.stackRequirements.framework !== 'vanilla' &&
      template.stackRequirements.framework !== currentStack.framework) {
    return false;
  }

  // TypeScript template can't be used in non-TS project
  if (template.stackRequirements.typescript && !currentStack.typescript) {
    return false;
  }

  // Check required dependencies are present
  for (const dep of template.stackRequirements.requiredDeps) {
    if (!(dep in currentStack.dependencies)) {
      return false;
    }
  }

  return true;
}

// ============================================================
// Helpers
// ============================================================

async function loadTemplateIndex(
  workspaceDir: string,
): Promise<Array<{ id: string; name: string; createdAt: string }>> {
  try {
    const raw = await readFile(
      join(workspaceDir, TEMPLATES_DIR, TEMPLATES_INDEX),
      'utf-8',
    );
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function mkdirSafe(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
