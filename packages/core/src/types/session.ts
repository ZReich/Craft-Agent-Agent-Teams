/**
 * Session types for conversation management
 *
 * Sessions are the primary isolation boundary. Each session maps 1:1
 * with a CraftAgent instance and SDK conversation.
 */

import type { StoredMessage, TokenUsage } from './message.ts';
import type { SpecComplianceReport } from './sdd.ts';

/**
 * Session status for workflow tracking
 * Agents can update this to reflect the current state of the conversation
 */
export type SessionStatus = 'todo' | 'in_progress' | 'needs_review' | 'done' | 'cancelled';
export type SessionLlmProvider = 'anthropic' | 'openai' | 'moonshot' | 'openrouter';

/**
 * Session represents a conversation scope (SDK session = our scope boundary)
 */
export interface Session {
  id: string;                    // Unique identifier (stable, known immediately)
  sdkSessionId?: string;         // SDK session ID (captured after first message)
  workspaceId: string;           // Which workspace this session belongs to
  name?: string;                 // Optional user-defined name
  createdAt: number;
  lastUsedAt: number;
  // Inbox/Archive features
  isArchived?: boolean;          // Whether this session is archived
  isFlagged?: boolean;           // Whether this session is flagged
  status?: SessionStatus;        // Workflow status (todo, in_progress, needs_review, done, cancelled)
  // Read/unread tracking
  lastReadMessageId?: string;    // ID of the last message the user has read
  // Sub-session hierarchy (1 level max)
  parentSessionId?: string;      // Parent session ID (if this is a sub-session)
  siblingOrder?: number;         // Explicit order among siblings (lazy - only set on reorder)
  // Agent Teams
  teamId?: string;               // If this session is part of a team, the team ID
  isTeamLead?: boolean;          // Whether this session is the team lead
  parentTeamSessionId?: string;  // For teammate sessions: the lead session ID
  // LLM metadata
  llmProvider?: SessionLlmProvider; // Canonical provider used by this session
  model?: string;                // Concrete model ID used by this session
  // SDD
  sddEnabled?: boolean;          // Spec mode toggle per session
  activeSpecId?: string;         // Currently active spec
  sddComplianceReports?: SpecComplianceReport[]; // Compliance reports generated
}

/**
 * Stored session with conversation data (for persistence)
 */
export interface StoredSession extends Session {
  messages: StoredMessage[];
  tokenUsage: TokenUsage;
}

/**
 * Session metadata for listing (without loading full messages)
 * Extended with archive status for Inbox/Archive features
 */
export interface SessionMetadata {
  id: string;
  workspaceId: string;
  name?: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
  preview?: string;        // Preview of first user message
  sdkSessionId?: string;
  // Inbox/Archive features
  isArchived?: boolean;    // Whether this session is archived
  isFlagged?: boolean;     // Whether this session is flagged
  status?: SessionStatus;  // Workflow status
  hidden?: boolean;        // Whether this session is hidden from session list
  // Sub-session hierarchy (1 level max)
  parentSessionId?: string;  // Parent session ID (if this is a sub-session)
  siblingOrder?: number;     // Explicit order among siblings (lazy - only set on reorder)
  // Agent Teams
  teamId?: string;         // If this session is part of a team
  isTeamLead?: boolean;    // Whether this is the team lead session
  // LLM metadata
  llmProvider?: SessionLlmProvider;
  model?: string;
  // SDD
  sddEnabled?: boolean;
  activeSpecId?: string;
  sddComplianceReports?: SpecComplianceReport[];
}
