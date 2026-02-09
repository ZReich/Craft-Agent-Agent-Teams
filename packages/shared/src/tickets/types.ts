/**
 * Ticket abstraction types.
 *
 * Providers normalize external ticket systems (GitHub, Craft, Local, etc.)
 * into a shared model for SDD/task-linking workflows.
 */

export interface Ticket {
  id: string;
  provider: TicketProviderType;
  externalId: string;
  title: string;
  description?: string;
  status: TicketStatus;
  url?: string;
  assignee?: string;
  labels?: string[];
  requirementIds?: string[];
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export type TicketProviderType = 'github' | 'craft' | 'linear' | 'local';

export type TicketStatus = 'open' | 'in-progress' | 'closed' | 'cancelled';

export interface TicketProvider {
  type: TicketProviderType;
  name: string;

  // CRUD
  listTickets(filter?: TicketFilter): Promise<Ticket[]>;
  getTicket(ticketId: string): Promise<Ticket | null>;
  updateTicketStatus(ticketId: string, status: TicketStatus): Promise<void>;

  // Linking
  linkToRequirement(ticketId: string, requirementId: string): Promise<void>;
  unlinkFromRequirement(ticketId: string, requirementId: string): Promise<void>;
  getTicketsForRequirement(requirementId: string): Promise<Ticket[]>;

  // Sync
  sync(): Promise<SyncResult>;

  // Auth
  isAuthenticated(): boolean;
  getAuthUrl?(): string;
}

export interface TicketFilter {
  status?: TicketStatus[];
  assignee?: string;
  labels?: string[];
  requirementId?: string;
  search?: string;
  limit?: number;
}

export interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  errors: string[];
  lastSyncAt: string;
}

export interface TicketConfig {
  providers: TicketProviderConfig[];
  syncInterval?: number;
  autoLink?: boolean;
}

export interface TicketProviderConfig {
  type: TicketProviderType;
  enabled: boolean;
  github?: { owner: string; repo: string; token?: string };
  craft?: { spaceId: string; documentId: string };
  linear?: { teamId: string; token?: string };
  local?: { storagePath?: string };
}

export interface LocalTicketStore {
  version: number;
  tickets: Ticket[];
}

export type RequirementLinkMap = Record<string, string[]>;

