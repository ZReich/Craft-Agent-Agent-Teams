/**
 * SDK Interception Helpers
 *
 * Centralizes all SDK PreToolUse interception result construction so
 * non-standard SDK boundary behavior is isolated in one place.
 *
 * Implements REQ-NEXT-007: Stabilize SDK interception layer.
 */

export interface SdkToolOverrideResult {
  outputContent: string;
  [key: string]: unknown;
}

const MAX_EXPECTED_SNIPPET = 160;

/**
 * Create a synthetic tool result override payload for PreToolUse hooks.
 *
 * NOTE: `outputContent` is currently relied on for Claude SDK interception
 * behavior and is intentionally isolated here for easier future migration
 * if the SDK provides an explicit override field.
 */
export function createToolOverrideResult(content: string): SdkToolOverrideResult {
  return { outputContent: content };
}

/**
 * Build a lightweight snippet used to verify interception behavior at runtime.
 */
export function buildOverrideSnippet(outputContent: string): string {
  const firstMeaningfulLine = outputContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? outputContent.trim();

  return firstMeaningfulLine.slice(0, MAX_EXPECTED_SNIPPET);
}

/**
 * Verify whether a tool result appears to contain the expected interception output.
 */
export function didToolOverrideMatch(expectedSnippet: string, actualResult: string): boolean {
  if (!expectedSnippet) return true;
  if (!actualResult) return false;
  return actualResult.includes(expectedSnippet);
}

/**
 * Verify whether the SDK appears to have applied an override payload.
 * Accepts unknown `toolResponse` to match hook/runtime payload flexibility.
 */
export function didToolOverrideApply(toolResponse: unknown, expectedSnippet: string): boolean {
  if (typeof toolResponse !== 'string') return false;
  return didToolOverrideMatch(expectedSnippet, toolResponse);
}
