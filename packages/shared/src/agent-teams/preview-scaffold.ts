/**
 * Preview Scaffold
 *
 * Framework-specific scaffolding that creates temporary preview routes
 * so each design variant runs as a live, interactive page on the project's
 * own dev server.
 *
 * Implements REQ-005: Preview Route Scaffolding
 */

import { mkdir, writeFile, readFile, rm, appendFile, stat, readdir as readdirFs, rmdir } from 'fs/promises';
import { join, dirname } from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { ProjectStack, DesignVariant } from '@craft-agent/core/types';

// ============================================================
// Public API
// ============================================================

export interface ScaffoldResult {
  /** Paths of all created files (for cleanup) */
  createdFiles: string[];
  /** Whether .gitignore was modified */
  gitignoreModified: boolean;
  /** Preview URLs for each variant */
  previewUrls: Map<string, string>;
}

/**
 * Create preview routes for each design variant based on the project's framework.
 * Files are written to `design-preview/` within the project directory.
 */
export async function scaffoldPreviewRoutes(
  projectDir: string,
  stack: ProjectStack,
  variants: DesignVariant[],
): Promise<ScaffoldResult> {
  const result: ScaffoldResult = {
    createdFiles: [],
    gitignoreModified: false,
    previewUrls: new Map(),
  };

  const port = stack.devPort ?? 3000;

  // Add design-preview/ to .gitignore
  result.gitignoreModified = await addToGitignore(projectDir);

  for (const variant of variants) {
    const files = await scaffoldVariant(projectDir, stack, variant, port);
    result.createdFiles.push(...files.createdFiles);
    if (files.previewUrl) {
      result.previewUrls.set(variant.id, files.previewUrl);
    }
  }

  return result;
}

/**
 * Probe whether a dev server is already running on the given port.
 * Returns true if the server responds to HTTP GET.
 */
export async function probeDevServer(port: number, host: string = 'localhost'): Promise<boolean> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://${host}:${port}`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok || res.status < 500;
    } catch {
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_DELAY);
      }
    }
  }
  return false;
}

/**
 * Start the project's dev server if not already running.
 * Returns the child process (caller is responsible for cleanup).
 */
export async function startDevServer(
  projectDir: string,
  stack: ProjectStack,
): Promise<{ process: ChildProcess | null; port: number; alreadyRunning: boolean }> {
  const port = stack.devPort ?? 3000;

  // Check if already running
  const running = await probeDevServer(port);
  if (running) {
    return { process: null, port, alreadyRunning: true };
  }

  const devCommand = stack.devCommand ?? 'npm run dev';
  const parts = devCommand.split(/\s+/);
  const cmd = parts[0] ?? 'npm';
  const args = parts.slice(1);

  const isWindows = process.platform === 'win32';
  const child: ChildProcess = spawn(cmd, args, {
    cwd: projectDir,
    shell: isWindows,
    stdio: 'pipe',
    detached: !isWindows,
  });

  // Wait for server to be ready (poll every 1s, max 30s)
  const ready = await waitForServer(port, 30_000);
  if (!ready) {
    child.kill();
    throw new Error(`Dev server failed to start within 30 seconds on port ${port}`);
  }

  return { process: child, port, alreadyRunning: false };
}

/**
 * Clean up preview routes and .gitignore entry.
 */
export async function cleanupPreviewRoutes(
  projectDir: string,
  createdFiles: string[],
): Promise<void> {
  // Remove the design-preview directory
  const previewDir = join(projectDir, 'design-preview');
  await rm(previewDir, { recursive: true, force: true });

  // Also remove framework-specific preview routes that may be outside design-preview/
  for (const file of createdFiles) {
    const absPath = join(projectDir, file);
    try {
      await rm(absPath, { force: true });
      // Try to remove empty parent dirs up to project root
      await removeEmptyParents(absPath, projectDir);
    } catch {
      // File already removed — safe to ignore
    }
  }

  // Remove .gitignore entry
  await removeFromGitignore(projectDir);
}

// ============================================================
// Framework-Specific Scaffolding
// ============================================================

interface VariantScaffoldResult {
  createdFiles: string[];
  previewUrl: string | null;
}

async function scaffoldVariant(
  projectDir: string,
  stack: ProjectStack,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  switch (stack.framework) {
    case 'nextjs':
      return stack.nextjsRouter === 'app'
        ? scaffoldNextAppRouter(projectDir, variant, port)
        : scaffoldNextPagesRouter(projectDir, variant, port);
    case 'remix':
      return scaffoldRemix(projectDir, variant, port);
    case 'react':
    case 'vue':
    case 'svelte':
      return scaffoldVite(projectDir, variant, port);
    default:
      return scaffoldFallback(projectDir, variant, port);
  }
}

/**
 * Next.js App Router: creates `app/design-preview/variant-{id}/page.tsx`
 */
async function scaffoldNextAppRouter(
  projectDir: string,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  const createdFiles: string[] = [];

  // Determine if src/app or app/
  const appDir = await dirExists(join(projectDir, 'src', 'app'))
    ? join('src', 'app')
    : 'app';

  const routeDir = join(appDir, 'design-preview', `variant-${variant.id}`);
  const pagePath = join(routeDir, 'page.tsx');

  // Write all variant files to design-preview/ storage first
  for (const file of variant.files) {
    const dest = join('design-preview', `variant-${variant.id}`, file.path);
    await writeFileRecursive(join(projectDir, dest), file.content);
    createdFiles.push(dest);
  }

  // Create the route page that imports the variant's main component
  const mainFile = variant.files.find(f =>
    f.path.includes('page') || f.path.includes('index') || f.path.includes('Page')
  ) ?? variant.files[0];

  if (mainFile) {
    const pageContent = generateNextAppPage(variant, mainFile, appDir);
    await writeFileRecursive(join(projectDir, pagePath), pageContent);
    createdFiles.push(pagePath);
  }

  return {
    createdFiles,
    previewUrl: `http://localhost:${port}/design-preview/variant-${variant.id}`,
  };
}

/**
 * Next.js Pages Router: creates `pages/design-preview/variant-{id}.tsx`
 */
async function scaffoldNextPagesRouter(
  projectDir: string,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  const createdFiles: string[] = [];

  // Write variant files
  for (const file of variant.files) {
    const dest = join('design-preview', `variant-${variant.id}`, file.path);
    await writeFileRecursive(join(projectDir, dest), file.content);
    createdFiles.push(dest);
  }

  // Create the page that imports the variant's main component
  const pagePath = join('pages', 'design-preview', `variant-${variant.id}.tsx`);
  const mainFile = variant.files.find(f =>
    f.path.includes('page') || f.path.includes('index') || f.path.includes('Page')
  ) ?? variant.files[0];
  if (mainFile) {
    const pageContent = generateNextPagesPage(variant, mainFile);
    await writeFileRecursive(join(projectDir, pagePath), pageContent);
    createdFiles.push(pagePath);
  }

  return {
    createdFiles,
    previewUrl: `http://localhost:${port}/design-preview/variant-${variant.id}`,
  };
}

/**
 * Remix: creates `app/routes/design-preview.variant-{id}.tsx`
 */
async function scaffoldRemix(
  projectDir: string,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  const createdFiles: string[] = [];

  for (const file of variant.files) {
    const dest = join('design-preview', `variant-${variant.id}`, file.path);
    await writeFileRecursive(join(projectDir, dest), file.content);
    createdFiles.push(dest);
  }

  // Remix flat file routing
  const routePath = join('app', 'routes', `design-preview.variant-${variant.id}.tsx`);
  const routeContent = `// Implements REQ-005: Preview route for design variant "${variant.name}"
export default function DesignPreview() {
  return <div id="design-preview-variant-${variant.id}">Design variant: ${variant.name}</div>;
}
`;
  await writeFileRecursive(join(projectDir, routePath), routeContent);
  createdFiles.push(routePath);

  return {
    createdFiles,
    previewUrl: `http://localhost:${port}/design-preview/variant-${variant.id}`,
  };
}

/**
 * Vite-based (React, Vue, Svelte): writes to design-preview/ with multi-page entry
 */
async function scaffoldVite(
  projectDir: string,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  const createdFiles: string[] = [];

  const variantDir = join('design-preview', `variant-${variant.id}`);

  for (const file of variant.files) {
    const dest = join(variantDir, file.path);
    await writeFileRecursive(join(projectDir, dest), file.content);
    createdFiles.push(dest);
  }

  // Create an index.html entry point for the variant
  const htmlPath = join(variantDir, 'index.html');
  const mainFile = variant.files.find(f => f.path.endsWith('.tsx') || f.path.endsWith('.jsx')) ?? variant.files[0];
  const htmlContent = generateViteHtml(variant, mainFile?.path ?? 'index.tsx');
  await writeFileRecursive(join(projectDir, htmlPath), htmlContent);
  createdFiles.push(htmlPath);

  return {
    createdFiles,
    previewUrl: `http://localhost:${port}/${variantDir}/`,
  };
}

/**
 * Fallback: standalone files in design-preview/ with a minimal HTML page
 */
async function scaffoldFallback(
  projectDir: string,
  variant: DesignVariant,
  port: number,
): Promise<VariantScaffoldResult> {
  const createdFiles: string[] = [];

  const variantDir = join('design-preview', `variant-${variant.id}`);
  for (const file of variant.files) {
    const dest = join(variantDir, file.path);
    await writeFileRecursive(join(projectDir, dest), file.content);
    createdFiles.push(dest);
  }

  return {
    createdFiles,
    previewUrl: null, // Fallback requires manual server setup
  };
}

// ============================================================
// Page Generators
// ============================================================

function generateNextAppPage(variant: DesignVariant, mainFile: DesignVariant['files'][0], appDir: string): string {
  // Compute relative path from {appDir}/design-preview/variant-{id}/ to project root
  // appDir = 'app' → 3 levels, appDir = 'src/app' → 4 levels
  const depth = appDir.split(/[\\/]/).length + 2; // +2 for design-preview/ and variant-{id}/
  const upPath = Array(depth).fill('..').join('/');

  return `// Implements REQ-005: Auto-generated preview route for design variant "${variant.name}"
// This file is temporary and will be removed after design selection.

import DesignPreview from '${upPath}/design-preview/variant-${variant.id}/${mainFile.path.replace(/\.[^.]+$/, '')}';

export default function DesignPreviewPage() {
  return <DesignPreview />;
}
`;
}

function generateNextPagesPage(variant: DesignVariant, mainFile: DesignVariant['files'][0]): string {
  // pages/design-preview/variant-{id}.tsx → 2 levels up to project root
  return `// Implements REQ-005: Auto-generated preview route for design variant "${variant.name}"
// This file is temporary and will be removed after design selection.

import DesignPreview from '../../design-preview/variant-${variant.id}/${mainFile.path.replace(/\.[^.]+$/, '')}';

export default function DesignPreviewPage() {
  return <DesignPreview />;
}
`;
}

function generateViteHtml(variant: DesignVariant, mainEntry: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Design Preview: ${variant.name}</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./${mainEntry}"></script>
</body>
</html>
`;
}

// ============================================================
// Gitignore Management
// ============================================================

const GITIGNORE_MARKER = '# design-preview (auto-generated, safe to delete)';
const GITIGNORE_ENTRY = `\n${GITIGNORE_MARKER}\ndesign-preview/\n`;

async function addToGitignore(projectDir: string): Promise<boolean> {
  const gitignorePath = join(projectDir, '.gitignore');
  try {
    const content = await readFile(gitignorePath, 'utf-8');
    if (content.includes('design-preview')) return false;
    await appendFile(gitignorePath, GITIGNORE_ENTRY);
    return true;
  } catch {
    // No .gitignore — create one
    await writeFile(gitignorePath, GITIGNORE_ENTRY.trimStart());
    return true;
  }
}

async function removeFromGitignore(projectDir: string): Promise<void> {
  const gitignorePath = join(projectDir, '.gitignore');
  try {
    let content = await readFile(gitignorePath, 'utf-8');
    content = content.replace(GITIGNORE_ENTRY, '').replace(`${GITIGNORE_MARKER}\ndesign-preview/\n`, '');
    await writeFile(gitignorePath, content);
  } catch {
    // No .gitignore — nothing to clean
  }
}

// ============================================================
// Filesystem Helpers
// ============================================================

async function writeFileRecursive(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf-8');
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function removeEmptyParents(filePath: string, stopAt: string): Promise<void> {
  let dir = dirname(filePath);
  while (dir !== stopAt && dir.startsWith(stopAt)) {
    try {
      const entries = await readdirFs(dir);
      if (entries.length === 0) {
        await rmdir(dir);
        dir = dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

async function waitForServer(port: number, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await probeDevServer(port);
    if (ready) return true;
    await sleep(1000);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
