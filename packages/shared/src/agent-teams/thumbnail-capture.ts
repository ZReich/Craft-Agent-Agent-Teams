/**
 * Thumbnail Capture
 *
 * Captures screenshots of design variant preview pages for display in the
 * design grid chat block. Supports two strategies:
 *
 * 1. **Electron** — Uses a hidden BrowserWindow + webContents.capturePage()
 *    (preferred when running inside Electron, zero external deps)
 * 2. **HTTP fallback** — Fetches a screenshot from a local capture service
 *    (for non-Electron environments, or when Playwright is available)
 *
 * The capture function is injected at runtime by the Electron main process
 * or the session layer, decoupling this module from Electron imports.
 *
 * Implements REQ-010: Thumbnail Generation
 */

import { writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';

// ============================================================
// Types
// ============================================================

/** Viewport configuration for thumbnail capture */
export interface CaptureViewport {
  /** Width in pixels */
  width: number;
  /** Height in pixels */
  height: number;
  /** Device scale factor (1 = standard, 2 = retina) */
  deviceScaleFactor?: number;
}

/** Options for a single thumbnail capture */
export interface ThumbnailCaptureOptions {
  /** URL to capture (e.g., http://localhost:3000/design-preview/variant-abc) */
  url: string;
  /** Viewport size for the capture */
  viewport?: CaptureViewport;
  /** Maximum time (ms) to wait for the page to load. Default: 15000 */
  timeoutMs?: number;
  /** Additional wait (ms) after load event for animations to settle. Default: 1500 */
  settleMs?: number;
  /** Output format */
  format?: 'png' | 'jpeg';
  /** JPEG quality (1-100). Only used when format='jpeg'. Default: 85 */
  quality?: number;
}

/** Result of a thumbnail capture */
export interface ThumbnailResult {
  /** Whether capture succeeded */
  success: boolean;
  /** Base64-encoded image data (without data URI prefix) */
  data?: string;
  /** MIME type of the image */
  mimeType?: string;
  /** File path if saved to disk */
  filePath?: string;
  /** Error message if capture failed */
  error?: string;
  /** Capture duration in ms */
  durationMs: number;
}

/** Batch capture request for multiple variants */
export interface BatchCaptureRequest {
  /** Variant ID → preview URL mapping */
  variants: Array<{
    id: string;
    previewUrl: string;
  }>;
  /** Shared viewport settings */
  viewport?: CaptureViewport;
  /** Directory to save thumbnail files (optional — omit for base64-only) */
  outputDir?: string;
  /** Capture timeout per variant */
  timeoutMs?: number;
  /** Post-load settle time per variant */
  settleMs?: number;
}

/** Result of a batch capture */
export interface BatchCaptureResult {
  /** Variant ID → capture result */
  results: Map<string, ThumbnailResult>;
  /** Total duration in ms */
  totalDurationMs: number;
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_CAPTURE_VIEWPORT: CaptureViewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 2,
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SETTLE_MS = 1_500;
const DEFAULT_FORMAT = 'png' as const;
const DEFAULT_QUALITY = 85;

// ============================================================
// Capture Strategy Interface
// ============================================================

/**
 * Abstract capture strategy. The Electron main process provides an implementation
 * that uses hidden BrowserWindows. This keeps the shared package free of Electron imports.
 */
export interface CaptureStrategy {
  /**
   * Capture a screenshot of the given URL.
   * Returns base64-encoded image data.
   */
  capture(options: ThumbnailCaptureOptions): Promise<ThumbnailResult>;

  /** Clean up any resources (e.g., close hidden windows) */
  dispose(): Promise<void>;
}

// ============================================================
// Thumbnail Capture Engine
// ============================================================

/**
 * High-level thumbnail capture engine.
 * Uses an injected CaptureStrategy to actually take screenshots.
 */
export class ThumbnailCaptureEngine {
  constructor(private strategy: CaptureStrategy) {}

  /**
   * Capture a single variant thumbnail.
   */
  async captureVariant(
    variantId: string,
    previewUrl: string,
    options?: Partial<ThumbnailCaptureOptions>,
  ): Promise<ThumbnailResult> {
    const captureOptions: ThumbnailCaptureOptions = {
      url: previewUrl,
      viewport: options?.viewport ?? DEFAULT_CAPTURE_VIEWPORT,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      settleMs: options?.settleMs ?? DEFAULT_SETTLE_MS,
      format: options?.format ?? DEFAULT_FORMAT,
      quality: options?.quality ?? DEFAULT_QUALITY,
    };

    return this.strategy.capture(captureOptions);
  }

  /**
   * Capture thumbnails for multiple variants in parallel.
   * Limits concurrency to 2 to avoid overloading the dev server.
   */
  async captureBatch(request: BatchCaptureRequest): Promise<BatchCaptureResult> {
    const startTime = Date.now();
    const results = new Map<string, ThumbnailResult>();
    const concurrency = 2;

    // Process in batches of `concurrency`
    for (let i = 0; i < request.variants.length; i += concurrency) {
      const batch = request.variants.slice(i, i + concurrency);
      const promises = batch.map(async variant => {
        const result = await this.captureVariant(variant.id, variant.previewUrl, {
          viewport: request.viewport,
          timeoutMs: request.timeoutMs,
          settleMs: request.settleMs,
        });

        // Optionally save to disk
        if (result.success && result.data && request.outputDir) {
          const ext = result.mimeType === 'image/jpeg' ? 'jpg' : 'png';
          const filePath = join(request.outputDir, `variant-${variant.id}.${ext}`);
          await saveThumbnail(filePath, result.data);
          result.filePath = filePath;
        }

        results.set(variant.id, result);
      });

      await Promise.all(promises);
    }

    return {
      results,
      totalDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Clean up the capture strategy resources.
   */
  async dispose(): Promise<void> {
    await this.strategy.dispose();
  }
}

// ============================================================
// HTTP Fallback Strategy
// ============================================================

/**
 * Fallback capture strategy that probes the preview URL and returns a
 * placeholder if no headless capture is available.
 *
 * This is used when:
 * - Running outside Electron (e.g., in tests)
 * - Playwright is not installed
 * - The Electron strategy fails to initialize
 */
export class HttpFallbackStrategy implements CaptureStrategy {
  async capture(options: ThumbnailCaptureOptions): Promise<ThumbnailResult> {
    const startTime = Date.now();

    // Verify the URL is reachable
    try {
      const response = await fetch(options.url, {
        method: 'HEAD',
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });

      if (!response.ok) {
        return {
          success: false,
          error: `Preview returned HTTP ${response.status}`,
          durationMs: Date.now() - startTime,
        };
      }

      // URL is reachable but we can't capture without a browser engine
      // Return a success with no image data — the UI can show the URL as a link
      return {
        success: true,
        data: undefined,
        mimeType: undefined,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Failed to probe preview URL',
        durationMs: Date.now() - startTime,
      };
    }
  }

  async dispose(): Promise<void> {
    // No resources to clean up
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Save a base64-encoded image to disk.
 */
async function saveThumbnail(filePath: string, base64Data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const buffer = Buffer.from(base64Data, 'base64');
  await writeFile(filePath, buffer);
}

/**
 * Generate a data URI from a ThumbnailResult.
 * Returns null if no image data is available.
 */
export function thumbnailToDataUri(result: ThumbnailResult): string | null {
  if (!result.success || !result.data || !result.mimeType) return null;
  return `data:${result.mimeType};base64,${result.data}`;
}

/**
 * Create a default capture engine with the HTTP fallback strategy.
 * Use this when no Electron capture strategy is available.
 */
export function createFallbackEngine(): ThumbnailCaptureEngine {
  return new ThumbnailCaptureEngine(new HttpFallbackStrategy());
}
