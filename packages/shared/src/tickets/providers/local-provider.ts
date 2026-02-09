import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { dirname, isAbsolute, join } from 'path';
import { readJsonFileSync } from '../../utils/files.ts';
import type {
  LocalTicketStore,
  SyncResult,
  Ticket,
  TicketFilter,
  TicketProvider,
  TicketStatus,
} from '../types.ts';

const DEFAULT_STORAGE_RELATIVE_PATH = join('tickets', 'local-tickets.json');

export interface CreateLocalTicketInput {
  title: string;
  description?: string;
  status?: TicketStatus;
  assignee?: string;
  labels?: string[];
  requirementIds?: string[];
  metadata?: Record<string, unknown>;
}

export class LocalTicketProvider implements TicketProvider {
  readonly type = 'local' as const;
  readonly name = 'Local Tickets';

  private readonly storagePath: string;

  constructor(
    private readonly workspaceRoot: string,
    storagePath?: string
  ) {
    this.storagePath = storagePath
      ? (isAbsolute(storagePath) ? storagePath : join(workspaceRoot, storagePath))
      : join(workspaceRoot, DEFAULT_STORAGE_RELATIVE_PATH);
    this.ensureStorage();
  }

  async listTickets(filter?: TicketFilter): Promise<Ticket[]> {
    const tickets = this.loadStore().tickets;
    return this.applyFilter(tickets, filter);
  }

  async getTicket(ticketId: string): Promise<Ticket | null> {
    const ticket = this.loadStore().tickets.find(
      (t) => t.id === ticketId || t.externalId === ticketId
    );
    return ticket ?? null;
  }

  async createTicket(input: CreateLocalTicketInput): Promise<Ticket> {
    const now = new Date().toISOString();
    const id = randomUUID();
    const ticket: Ticket = {
      id,
      provider: 'local',
      externalId: id,
      title: input.title,
      description: input.description,
      status: input.status ?? 'open',
      assignee: input.assignee,
      labels: input.labels ?? [],
      requirementIds: input.requirementIds ?? [],
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    const store = this.loadStore();
    store.tickets.push(ticket);
    this.saveStore(store);
    return ticket;
  }

  async updateTicket(
    ticketId: string,
    updates: Partial<Omit<Ticket, 'id' | 'provider' | 'externalId' | 'createdAt'>>
  ): Promise<Ticket | null> {
    const store = this.loadStore();
    const idx = store.tickets.findIndex(
      (t) => t.id === ticketId || t.externalId === ticketId
    );
    if (idx === -1) return null;

    const existing = store.tickets[idx]!;
    const updated: Ticket = {
      ...existing,
      ...updates,
      id: existing.id,
      provider: 'local',
      externalId: existing.externalId,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };
    store.tickets[idx] = updated;
    this.saveStore(store);
    return updated;
  }

  async deleteTicket(ticketId: string): Promise<boolean> {
    const store = this.loadStore();
    const before = store.tickets.length;
    store.tickets = store.tickets.filter(
      (t) => t.id !== ticketId && t.externalId !== ticketId
    );
    const removed = store.tickets.length !== before;
    if (removed) {
      this.saveStore(store);
    }
    return removed;
  }

  async updateTicketStatus(ticketId: string, status: TicketStatus): Promise<void> {
    await this.updateTicket(ticketId, { status });
  }

  async linkToRequirement(ticketId: string, requirementId: string): Promise<void> {
    await this.updateTicket(ticketId, {
      requirementIds: this.withRequirementId(
        (await this.getTicket(ticketId))?.requirementIds,
        requirementId
      ),
    });
  }

  async unlinkFromRequirement(ticketId: string, requirementId: string): Promise<void> {
    const ticket = await this.getTicket(ticketId);
    if (!ticket?.requirementIds?.length) return;
    await this.updateTicket(ticketId, {
      requirementIds: ticket.requirementIds.filter((id) => id !== requirementId),
    });
  }

  async getTicketsForRequirement(requirementId: string): Promise<Ticket[]> {
    const tickets = this.loadStore().tickets;
    return tickets.filter((ticket) => ticket.requirementIds?.includes(requirementId));
  }

  async sync(): Promise<SyncResult> {
    return {
      added: 0,
      updated: 0,
      removed: 0,
      errors: [],
      lastSyncAt: new Date().toISOString(),
    };
  }

  isAuthenticated(): boolean {
    return true;
  }

  private ensureStorage(): void {
    const parentDir = dirname(this.storagePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    if (!existsSync(this.storagePath)) {
      this.saveStore({ version: 1, tickets: [] });
    }
  }

  private loadStore(): LocalTicketStore {
    this.ensureStorage();
    try {
      const parsed = readJsonFileSync<LocalTicketStore>(this.storagePath);
      if (!parsed || !Array.isArray(parsed.tickets)) {
        return { version: 1, tickets: [] };
      }
      return parsed;
    } catch {
      return { version: 1, tickets: [] };
    }
  }

  private saveStore(store: LocalTicketStore): void {
    const parentDir = dirname(this.storagePath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }
    writeFileSync(this.storagePath, JSON.stringify(store, null, 2), 'utf-8');
  }

  private withRequirementId(existing: string[] | undefined, requirementId: string): string[] {
    const current = existing ?? [];
    if (current.includes(requirementId)) return current;
    return [...current, requirementId];
  }

  private applyFilter(tickets: Ticket[], filter?: TicketFilter): Ticket[] {
    if (!filter) return [...tickets];

    const normalizedSearch = filter.search?.trim().toLowerCase();
    const filtered = tickets.filter((ticket) => {
      if (filter.status?.length && !filter.status.includes(ticket.status)) return false;
      if (filter.assignee && ticket.assignee !== filter.assignee) return false;
      if (filter.labels?.length) {
        const ticketLabels = new Set(ticket.labels ?? []);
        if (!filter.labels.every((label) => ticketLabels.has(label))) return false;
      }
      if (filter.requirementId && !ticket.requirementIds?.includes(filter.requirementId)) {
        return false;
      }
      if (normalizedSearch) {
        const haystack = `${ticket.title} ${ticket.description ?? ''}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }
      return true;
    });

    if (typeof filter.limit === 'number' && filter.limit > 0) {
      return filtered.slice(0, filter.limit);
    }
    return filtered;
  }
}
