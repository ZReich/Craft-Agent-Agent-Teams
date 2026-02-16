/**
 * Electron Capture Strategy
 *
 * Implements the CaptureStrategy interface using Electron's hidden BrowserWindow
 * and webContents.capturePage(). This produces pixel-perfect screenshots of
 * design variant previews without external dependencies.
 *
 * The hidden window is created on first capture and reused across captures
 * within the same batch. It is destroyed when dispose() is called.
 *
 * Implements REQ-010: Thumbnail Generation (Electron strategy)
 */

import { BrowserWindow } from 'electron';
import type {
  CaptureStrategy,
  ThumbnailCaptureOptions,
  ThumbnailResult,
} from '@craft-agent/shared/agent-teams/thumbnail-capture';

const DEFAULT_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 2 };
const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_SETTLE = 1_500;

export class ElectronCaptureStrategy implements CaptureStrategy {
  private window: BrowserWindow | null = null;

  /**
   * Get or create the hidden capture window.
   */
  private getWindow(width: number, height: number, deviceScaleFactor: number): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) {
      // Resize if needed
      this.window.setSize(width, height);
      return this.window;
    }

    this.window = new BrowserWindow({
      width,
      height,
      show: false,  // Hidden — never shown to the user
      webPreferences: {
        offscreen: true,  // Enable offscreen rendering for capture
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    // Set device scale factor for retina-quality captures
    this.window.webContents.setZoomFactor(deviceScaleFactor);

    return this.window;
  }

  async capture(options: ThumbnailCaptureOptions): Promise<ThumbnailResult> {
    const startTime = Date.now();
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    const settleMs = options.settleMs ?? DEFAULT_SETTLE;
    const format = options.format ?? 'png';

    try {
      const win = this.getWindow(viewport.width, viewport.height, viewport.deviceScaleFactor ?? 2);

      // Load the URL with a timeout
      await Promise.race([
        win.loadURL(options.url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Page load timed out after ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);

      // Wait for animations to settle
      if (settleMs > 0) {
        await new Promise(resolve => setTimeout(resolve, settleMs));
      }

      // Capture the page
      const image = await win.webContents.capturePage();

      // Convert to the requested format
      let buffer: Buffer;
      let mimeType: string;

      if (format === 'jpeg') {
        buffer = image.toJPEG(options.quality ?? 85);
        mimeType = 'image/jpeg';
      } else {
        buffer = image.toPNG();
        mimeType = 'image/png';
      }

      return {
        success: true,
        data: buffer.toString('base64'),
        mimeType,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Screenshot capture failed',
        durationMs: Date.now() - startTime,
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy();
      this.window = null;
    }
  }
}
