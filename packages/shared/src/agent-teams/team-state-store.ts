/**
 * Team State Store
 *
 * Append-only JSONL persistence for team runtime state (messages, tasks, activity).
 * Stores data at {sessionPath}/team-state.jsonl so that closing and reopening
 * the app restores the full team conversation and task history.
 *
 * Implements REQ-002: Persist team data across close/reopen.
 *
 * File format — one JSON object per line:
 *   {"t":"msg","d":<TeammateMessage>}
 *   {"t":"task","d":<TeamTask>}
 *   {"t":"act","d":<TeamActivityEvent>}
 */

import { existsSync, appendFileSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type {
  TeammateMessage,
  TeamTask,
  TeamActivityEvent,
} from '@craft-agent/core/types';

// ============================================================
// Types
// ============================================================

interface TeamStateEntry {
  /** Type tag: msg = message, task = task, act = activity */
  t: 'msg' | 'task' | 'act';
  /** Payload */
  d: TeammateMessage | TeamTask | TeamActivityEvent;
}

export interface TeamState {
  messages: TeammateMessage[];
  tasks: TeamTask[];
  activity: TeamActivityEvent[];
}

// ============================================================
// Implementation
// ============================================================

export class TeamStateStore {
  private filePath: string;

  constructor(sessionDirPath: string) {
    this.filePath = join(sessionDirPath, 'team-state.jsonl');
  }

  // ── Append Operations ───────────────────────────────────────

  appendMessage(msg: TeammateMessage): void {
    this.appendEntry({ t: 'msg', d: msg });
  }

  appendTask(task: TeamTask): void {
    this.appendEntry({ t: 'task', d: task });
  }

  appendActivity(event: TeamActivityEvent): void {
    this.appendEntry({ t: 'act', d: event });
  }

  // ── Load All State ──────────────────────────────────────────

  load(): TeamState {
    const result: TeamState = { messages: [], tasks: [], activity: [] };

    if (!existsSync(this.filePath)) {
      return result;
    }

    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf-8');
    } catch {
      return result;
    }

    const taskMap = new Map<string, TeamTask>();

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let entry: TeamStateEntry;
      try {
        entry = JSON.parse(trimmed);
      } catch {
        // Skip malformed lines
        continue;
      }

      switch (entry.t) {
        case 'msg':
          result.messages.push(entry.d as TeammateMessage);
          break;
        case 'task': {
          // Tasks can be updated — keep latest version by ID
          const task = entry.d as TeamTask;
          taskMap.set(task.id, task);
          break;
        }
        case 'act':
          result.activity.push(entry.d as TeamActivityEvent);
          break;
      }
    }

    // Convert task map to array, preserving order of first appearance
    result.tasks = Array.from(taskMap.values());

    return result;
  }

  // ── Compact ─────────────────────────────────────────────────

  /**
   * Compact the JSONL file: deduplicate tasks (keep latest version),
   * and rewrite the file with clean entries.
   */
  compact(): void {
    const state = this.load();

    // Rewrite the file from scratch
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const lines: string[] = [];

    for (const msg of state.messages) {
      lines.push(JSON.stringify({ t: 'msg', d: msg }));
    }
    for (const task of state.tasks) {
      lines.push(JSON.stringify({ t: 'task', d: task }));
    }
    for (const act of state.activity) {
      lines.push(JSON.stringify({ t: 'act', d: act }));
    }

    writeFileSync(this.filePath, lines.join('\n') + '\n', 'utf-8');
  }

  // ── Internal ────────────────────────────────────────────────

  private appendEntry(entry: TeamStateEntry): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      // Non-fatal: log and continue (don't crash the team)
      console.error('[TeamStateStore] Failed to append entry:', err);
    }
  }
}
