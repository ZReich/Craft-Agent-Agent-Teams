/**
 * SDK Interception Helpers
 *
 * Implements REQ-NEXT-007: Stabilize SDK interception layer.
 *
 * NOTE: The previous `outputContent` / `createToolOverrideResult` mechanism has been removed.
 * The Claude Agent SDK (v0.2.19+) does not process an `outputContent` field on PreToolUse hook
 * returns — it is silently ignored. Agent team tool interception (TeamCreate, Task with team_name,
 * SendMessage) now uses `{ decision: 'block', reason: '...' }` which is fully supported by the SDK
 * and prevents native tool execution while giving Claude an informative response.
 *
 * This file is retained for any future interception utilities.
 */

/**
 * Verify whether a tool result appears to contain an expected snippet.
 * Kept for use in tests that assert specific content in tool results.
 */
export function didToolOverrideMatch(expectedSnippet: string, actualResult: string): boolean {
  if (!expectedSnippet) return true;
  if (!actualResult) return false;
  return actualResult.includes(expectedSnippet);
}
