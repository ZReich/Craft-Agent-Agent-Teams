/**
 * Parallel build orchestrator — runs independent build steps concurrently
 * Replaces the sequential electron:build chain for faster startup
 */

import { spawn } from "bun";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");

async function runScript(name: string): Promise<void> {
  console.log(`  Starting ${name}...`);
  const start = Date.now();

  const proc = spawn({
    cmd: ["bun", "run", name],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });

  const code = await proc.exited;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (code !== 0) {
    throw new Error(`${name} failed with exit code ${code} (${elapsed}s)`);
  }

  console.log(`  ✅ ${name} done (${elapsed}s)`);
}

async function main() {
  const totalStart = Date.now();
  console.log("⚡ Running parallel build...\n");

  // Phase 1: Independent steps in parallel
  // - main: builds MCP servers + copilot interceptor + main process bundle
  // - preload: builds preload script (independent)
  // - renderer: full Vite/React build (independent, slowest)
  console.log("Phase 1: Building main, preload, and renderer in parallel...");
  await Promise.all([
    runScript("electron:build:main"),
    runScript("electron:build:preload"),
    runScript("electron:build:renderer"),
  ]);

  // Phase 2: Steps that depend on Phase 1 output
  // - resources: copies resources dir (includes MCP server outputs from main build)
  // - assets: copies doc assets
  console.log("\nPhase 2: Copying resources and assets...");
  await Promise.all([
    runScript("electron:build:resources"),
    runScript("electron:build:assets"),
  ]);

  const totalElapsed = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`\n✅ Parallel build complete (${totalElapsed}s)`);
}

main().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
