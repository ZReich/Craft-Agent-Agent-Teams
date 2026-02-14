import { loadWorkspaceSources } from '../../sources/storage.ts';
import type {
  SyncResult,
  Ticket,
  TicketFilter,
  TicketProvider,
  TicketProviderConfig,
  TicketStatus,
} from '../types.ts';

/**
 * Craft ticket provider (stub).
 *
 * Expected integration points:
 * 1) Resolve Craft source connection from workspace source configs
 *    (provider === "craft", type usually "mcp").
 * 2) Use the existing source/auth system to confirm connectivity and credentials.
 * 3) Query Craft objects over MCP tools (documents/blocks/tasks) and normalize to Ticket.
 * 4) Persist requirement links locally unless Craft API gains native relation fields.
 */
export class CraftTicketProvider implements TicketProvider {
  readonly type = 'craft' as const;
  readonly name = 'Craft';

  constructor(
    private readonly workspaceRoot: string,
    private readonly _config?: TicketProviderConfig['craft']
  ) {}

  async listTickets(_filter?: TicketFilter): Promise<Ticket[]> {
    // Implements REQ-002: Return a safe empty result until Craft ticket tooling is available.
    return [];
  }

  async getTicket(_ticketId: string): Promise<Ticket | null> {
    return null;
  }

  async updateTicketStatus(_ticketId: string, _status: TicketStatus): Promise<void> {
    throw new Error('Craft ticket status updates are not supported by the current provider integration.');
  }

  async linkToRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Craft requirement linking is not supported by the current provider integration.');
  }

  async unlinkFromRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Craft requirement unlinking is not supported by the current provider integration.');
  }

  async getTicketsForRequirement(_requirementId: string): Promise<Ticket[]> {
    return [];
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
    const sources = loadWorkspaceSources(this.workspaceRoot);
    return sources.some((source) => source.config.provider === 'craft');
  }
}

