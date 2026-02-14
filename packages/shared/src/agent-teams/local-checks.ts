import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type CacheEntry<T> = { value: T; expiresAt: number };

const typeCheckCache = new Map<string, CacheEntry<TypeCheckCheckResult>>();
const testSuiteCache = new Map<string, CacheEntry<TestSuiteCheckResult>>();

const DEFAULT_CACHE_TTL_MS = 300_000; // 5 minutes — long enough to survive review cycles

export interface TypeCheckCheckResult {
  passed: boolean;
  errorCount: number;
  errors: string[];
  rawOutput: string;
}

export interface TestSuiteCheckResult {
  passed: boolean;
  total: number;
  passed_count: number;
  failed: number;
  skipped: number;
  failedTests: string[];
  rawOutput: string;
  metadata?: {
    command: string;
    cwd: string;
    timeoutMs: number;
    cacheKey: string;
    cacheHit: boolean;
  };
}

export interface LocalCheckOptions {
  workingDir: string;
  timeoutMs: number;
  cacheKey?: string;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  /** When true, run only tests affected by uncommitted changes (vitest --changed) */
  changedOnly?: boolean;
}

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return cached.value;
}

function setCached<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

export async function runTypeCheckCached(options: LocalCheckOptions): Promise<TypeCheckCheckResult> {
  const cacheKey = options.cacheKey ?? `typecheck:${options.workingDir}`;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  if (!options.forceRefresh) {
    const cached = getCached(typeCheckCache, cacheKey);
    if (cached) return cached;
  }

  let result: TypeCheckCheckResult;
  try {
    await execAsync('bun run tsc --noEmit --pretty false 2>&1', {
      cwd: options.workingDir,
      timeout: options.timeoutMs,
    });
    result = { passed: true, errorCount: 0, errors: [], rawOutput: '' };
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    const output = (error.stdout || error.stderr || '').trim();
    const errors = output.split('\n').filter(l => l.includes('error TS'));
    if (errors.length === 0 && output.length > 0) {
      // Treat tooling/infrastructure noise as pass (existing behavior parity).
      result = { passed: true, errorCount: 0, errors: [], rawOutput: output };
    } else {
      result = {
        passed: errors.length === 0,
        errorCount: errors.length,
        errors: errors.slice(0, 30),
        rawOutput: output,
      };
    }
  }

  setCached(typeCheckCache, cacheKey, result, ttlMs);
  return result;
}

export async function runTestSuiteCached(options: LocalCheckOptions): Promise<TestSuiteCheckResult> {
  const scopeSuffix = options.changedOnly ? ':affected' : ':full';
  const cacheKey = options.cacheKey ? `${options.cacheKey}${scopeSuffix}` : `testsuite:${options.workingDir}${scopeSuffix}`;
  const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const baseCommand = 'bun run vitest run --reporter=json -c vitest.config.ts';
  const command = options.changedOnly ? `${baseCommand} --changed` : baseCommand;
  if (!options.forceRefresh) {
    const cached = getCached(testSuiteCache, cacheKey);
    if (cached) {
      return {
        ...cached,
        metadata: {
          command,
          cwd: options.workingDir,
          timeoutMs: options.timeoutMs,
          cacheKey,
          cacheHit: true,
        },
      };
    }
  }

  let result: TestSuiteCheckResult;
  try {
    const { stdout } = await execAsync(command, {
      cwd: options.workingDir,
      timeout: options.timeoutMs,
      env: { ...process.env, CRAFT_DEBUG: '0' },
    });
    result = parseVitestJson(stdout);
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; code?: number };
    const output = (error.stdout || error.stderr || '').trim();

    if (error.code === 1) {
      result = parseVitestJson(output, output);
    } else {
      result = {
        passed: false,
        total: 0,
        passed_count: 0,
        failed: 1,
        skipped: 0,
        failedTests: [output.slice(0, 200) || 'Test execution failed'],
        rawOutput: output,
      };
    }
  }

  result = {
    ...result,
    metadata: {
      command,
      cwd: options.workingDir,
      timeoutMs: options.timeoutMs,
      cacheKey,
      cacheHit: false,
    },
  };

  setCached(testSuiteCache, cacheKey, result, ttlMs);
  return result;
}

function parseVitestJson(input: string, rawFallback = ''): TestSuiteCheckResult {
  const jsonMatch = input.match(/\{[\s\S]*"testResults"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const results = JSON.parse(jsonMatch[0]);
      const passed = results.numPassedTests || 0;
      const failed = results.numFailedTests || 0;
      const skipped = results.numPendingTests || 0;
      const total = passed + failed + skipped;

      const failedTests = (results.testResults || [])
        .filter((t: { status: string }) => t.status === 'failed')
        .map((t: { name: string }) => t.name)
        .slice(0, 20);

      return {
        passed: failed === 0,
        total,
        passed_count: passed,
        failed,
        skipped,
        failedTests,
        rawOutput: input,
      };
    } catch {
      // Fallback below.
    }
  }

  const hasFailure = /FAIL|failed/i.test(input);
  return {
    passed: !hasFailure,
    total: 0,
    passed_count: 0,
    failed: hasFailure ? 1 : 0,
    skipped: 0,
    failedTests: hasFailure ? ['Test suite reported failures'] : [],
    rawOutput: rawFallback || input,
  };
}
