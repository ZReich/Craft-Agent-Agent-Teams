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
    throw new Error('Not yet implemented: Craft ticket listing via MCP source integration');
  }

  async getTicket(_ticketId: string): Promise<Ticket | null> {
    throw new Error('Not yet implemented: Craft ticket lookup via MCP source integration');
  }

  async updateTicketStatus(_ticketId: string, _status: TicketStatus): Promise<void> {
    throw new Error('Not yet implemented: Craft ticket status updates via MCP source integration');
  }

  async linkToRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Not yet implemented: Craft requirement link updates');
  }

  async unlinkFromRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Not yet implemented: Craft requirement unlink updates');
  }

  async getTicketsForRequirement(_requirementId: string): Promise<Ticket[]> {
    throw new Error('Not yet implemented: Craft requirement ticket lookup');
  }

  async sync(): Promise<SyncResult> {
    throw new Error('Not yet implemented: Craft ticket sync via MCP source integration');
  }

  isAuthenticated(): boolean {
    const sources = loadWorkspaceSources(this.workspaceRoot);
    return sources.some((source) => source.config.provider === 'craft');
  }
}

