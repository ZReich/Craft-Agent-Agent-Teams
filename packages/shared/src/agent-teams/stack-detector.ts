/**
 * Stack Detector
 *
 * Automated project technology stack detection. Scans the working directory
 * to identify framework, styling, animation library, component inventory,
 * dev server config, and existing patterns.
 *
 * Implements REQ-001: Automated Project Stack Detection
 */

import { readFile, readdir, access, stat } from 'fs/promises';
import { join, basename, extname } from 'path';
import type { ProjectStack } from '@craft-agent/core/types';

// ============================================================
// Public API
// ============================================================

/**
 * Detect the project's technology stack by scanning the working directory.
 * Returns a `ProjectStack` with all identifiable fields populated;
 * undetectable fields are set to `null` or empty arrays.
 */
export async function detectProjectStack(workingDir: string): Promise<ProjectStack> {
  const pkg = await readPackageJson(workingDir);
  const allDeps = pkg ? { ...pkg.dependencies, ...pkg.devDependencies } : {};

  const framework = detectFramework(allDeps);
  const nextjsRouter = framework === 'nextjs' ? await detectNextjsRouter(workingDir) : undefined;
  const typescript = await detectTypeScript(workingDir, allDeps);
  const styling = await detectStyling(workingDir, allDeps);
  const animationLibrary = detectAnimationLibrary(allDeps);
  const uiLibrary = detectUILibrary(workingDir, allDeps);
  const components = await inventoryComponents(workingDir, framework);
  const devCommand = pkg?.scripts?.dev ?? null;
  const devPort = parseDevPort(devCommand, framework);
  const patterns = await detectPatterns(workingDir, framework);

  return {
    framework,
    nextjsRouter,
    typescript,
    styling,
    animationLibrary,
    components,
    uiLibrary,
    devCommand,
    devPort,
    patterns,
    dependencies: allDeps,
  };
}

// ============================================================
// Package.json
// ============================================================

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

async function readPackageJson(dir: string): Promise<PackageJson | null> {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ============================================================
// Framework Detection
// ============================================================

function detectFramework(deps: Record<string, string>): ProjectStack['framework'] {
  // Order matters — more specific frameworks checked first
  if ('next' in deps) return 'nextjs';
  if ('@remix-run/react' in deps || 'remix' in deps) return 'remix';
  if ('astro' in deps) return 'astro';
  if ('svelte' in deps || '@sveltejs/kit' in deps) return 'svelte';
  if ('vue' in deps || 'nuxt' in deps) return 'vue';
  if ('react' in deps || 'react-dom' in deps) return 'react';
  return Object.keys(deps).length > 0 ? 'vanilla' : null;
}

async function detectNextjsRouter(dir: string): Promise<'app' | 'pages'> {
  // App Router uses `app/` directory, Pages Router uses `pages/`
  const hasAppDir = await exists(join(dir, 'app'));
  const hasSrcAppDir = await exists(join(dir, 'src', 'app'));
  if (hasAppDir || hasSrcAppDir) return 'app';
  return 'pages';
}

// ============================================================
// TypeScript Detection
// ============================================================

async function detectTypeScript(dir: string, deps: Record<string, string>): Promise<boolean> {
  if ('typescript' in deps) return true;
  if (await exists(join(dir, 'tsconfig.json'))) return true;
  // Check for .ts/.tsx files in src/
  try {
    const srcDir = join(dir, 'src');
    const entries = await readdir(srcDir, { recursive: false });
    return entries.some(e => e.endsWith('.ts') || e.endsWith('.tsx'));
  } catch {
    return false;
  }
}

// ============================================================
// Styling Detection
// ============================================================

async function detectStyling(dir: string, deps: Record<string, string>): Promise<ProjectStack['styling']> {
  const tailwind = 'tailwindcss' in deps;
  let tailwindConfig: Record<string, unknown> | null = null;

  if (tailwind) {
    tailwindConfig = await readTailwindConfig(dir);
  }

  return {
    tailwind,
    tailwindConfig,
    cssModules: await hasCSSModules(dir),
    styledComponents: 'styled-components' in deps || '@emotion/styled' in deps,
    other: detectOtherCSS(deps),
  };
}

async function readTailwindConfig(dir: string): Promise<Record<string, unknown> | null> {
  // Try common config file names
  const candidates = [
    'tailwind.config.js',
    'tailwind.config.ts',
    'tailwind.config.mjs',
    'tailwind.config.cjs',
  ];

  for (const name of candidates) {
    try {
      const raw = await readFile(join(dir, name), 'utf-8');
      // Extract the theme/extend section as a rough parse (not full eval)
      // We return the raw content as a string under a 'raw' key for the LLM to read
      return { _raw: raw, _file: name };
    } catch {
      continue;
    }
  }
  return null;
}

async function hasCSSModules(dir: string): Promise<boolean> {
  try {
    const srcDir = join(dir, 'src');
    const entries = await readdir(srcDir, { recursive: true });
    return entries.some(e => e.includes('.module.css') || e.includes('.module.scss'));
  } catch {
    return false;
  }
}

function detectOtherCSS(deps: Record<string, string>): string[] {
  const others: string[] = [];
  if ('sass' in deps || 'node-sass' in deps) others.push('sass');
  if ('less' in deps) others.push('less');
  if ('@vanilla-extract/css' in deps) others.push('vanilla-extract');
  if ('postcss' in deps) others.push('postcss');
  return others;
}

// ============================================================
// Animation Library Detection
// ============================================================

function detectAnimationLibrary(deps: Record<string, string>): ProjectStack['animationLibrary'] {
  if ('framer-motion' in deps) return 'framer-motion';
  if ('motion' in deps) return 'motion';
  if ('react-spring' in deps || '@react-spring/web' in deps) return 'react-spring';
  if ('gsap' in deps) return 'gsap';
  return null;
}

// ============================================================
// UI Library Detection
// ============================================================

function detectUILibrary(dir: string, deps: Record<string, string>): string | null {
  // shadcn/ui is detected by the presence of components.json or ui/ dir + radix deps
  if ('@radix-ui/react-dialog' in deps || '@radix-ui/react-slot' in deps) {
    return 'shadcn';
  }
  if ('@mantine/core' in deps) return 'mantine';
  if ('@mui/material' in deps) return 'mui';
  if ('@chakra-ui/react' in deps) return 'chakra';
  if ('antd' in deps) return 'antd';
  if ('@headlessui/react' in deps) return 'headlessui';
  return null;
}

// ============================================================
// Component Inventory
// ============================================================

async function inventoryComponents(
  dir: string,
  framework: ProjectStack['framework'],
): Promise<Array<{ name: string; path: string }>> {
  const components: Array<{ name: string; path: string }> = [];

  // Common component directories
  const candidateDirs = [
    'src/components',
    'src/components/ui',
    'components',
    'components/ui',
    'app/components',
    'src/app/components',
  ];

  for (const relDir of candidateDirs) {
    const absDir = join(dir, relDir);
    try {
      const entries = await readdir(absDir, { withFileTypes: true });
      for (const entry of entries) {
        const ext = extname(entry.name);
        const componentExts = ['.tsx', '.jsx', '.vue', '.svelte'];
        if (entry.isFile() && componentExts.includes(ext)) {
          const name = basename(entry.name, ext);
          // Skip index files and test files
          if (name === 'index' || name.includes('.test') || name.includes('.spec')) continue;
          components.push({ name, path: join(relDir, entry.name) });
        } else if (entry.isDirectory()) {
          // Check for index file inside directory (component folder pattern)
          const indexCandidates = ['index.tsx', 'index.jsx', `${entry.name}.tsx`, `${entry.name}.jsx`];
          for (const indexFile of indexCandidates) {
            if (await exists(join(absDir, entry.name, indexFile))) {
              components.push({ name: entry.name, path: join(relDir, entry.name, indexFile) });
              break;
            }
          }
        }
      }
    } catch {
      // Directory doesn't exist — skip
      continue;
    }
  }

  return components;
}

// ============================================================
// Pattern Detection (layouts, pages, hooks, contexts)
// ============================================================

async function detectPatterns(
  dir: string,
  framework: ProjectStack['framework'],
): Promise<ProjectStack['patterns']> {
  const patterns: ProjectStack['patterns'] = {
    layouts: [],
    pages: [],
    hooks: [],
    contexts: [],
  };

  // Layout files
  const layoutPaths = [
    'src/app/layout.tsx', 'src/app/layout.jsx', 'app/layout.tsx', 'app/layout.jsx',
    'src/layouts', 'src/components/layouts',
  ];
  for (const p of layoutPaths) {
    const abs = join(dir, p);
    const s = await safeStat(abs);
    if (s?.isFile()) {
      patterns.layouts.push(p);
    } else if (s?.isDirectory()) {
      const entries = await safeReaddir(abs);
      patterns.layouts.push(...entries.filter(e => !e.includes('.test')).map(e => join(p, e)));
    }
  }

  // Page files (Next.js app router pages, or pages/ dir)
  const pageDirs = ['src/app', 'app', 'src/pages', 'pages'];
  for (const pd of pageDirs) {
    const abs = join(dir, pd);
    try {
      const entries = await readdir(abs, { withFileTypes: true, recursive: true });
      for (const entry of entries) {
        if (entry.isFile() && (entry.name === 'page.tsx' || entry.name === 'page.jsx' || entry.name.endsWith('.page.tsx'))) {
          // Reconstruct the relative path from the entry
          const parentPath = (entry as unknown as { parentPath?: string }).parentPath;
          const entryPath = parentPath ? join(parentPath, entry.name) : entry.name;
          const relPath = entryPath.replace(dir, '').replace(/^[\\/]/, '');
          patterns.pages.push(relPath);
        }
      }
    } catch {
      continue;
    }
  }

  // Hooks
  const hookDirs = ['src/hooks', 'src/lib/hooks', 'hooks'];
  for (const hd of hookDirs) {
    const entries = await safeReaddir(join(dir, hd));
    patterns.hooks.push(...entries.filter(e => e.startsWith('use') || e.startsWith('Use')).map(e => join(hd, e)));
  }

  // Contexts
  const contextDirs = ['src/contexts', 'src/context', 'src/providers'];
  for (const cd of contextDirs) {
    const entries = await safeReaddir(join(dir, cd));
    patterns.contexts.push(...entries.filter(e => !e.includes('.test')).map(e => join(cd, e)));
  }

  return patterns;
}

// ============================================================
// Dev Server Port Parsing
// ============================================================

function parseDevPort(devCommand: string | null, framework: ProjectStack['framework']): number | null {
  if (!devCommand) return null;

  // Check for explicit port flags
  const portMatch = devCommand.match(/(?:-p|--port)\s+(\d+)/) || devCommand.match(/PORT=(\d+)/);
  if (portMatch?.[1]) return parseInt(portMatch[1], 10);

  // Framework defaults
  switch (framework) {
    case 'nextjs': return 3000;
    case 'remix': return 3000;
    case 'react': return 3000; // CRA default, Vite is 5173
    case 'vue': return 5173;
    case 'svelte': return 5173;
    case 'astro': return 4321;
    default: return 3000;
  }
}

// ============================================================
// Filesystem Helpers
// ============================================================

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function safeStat(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function safeReaddir(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
