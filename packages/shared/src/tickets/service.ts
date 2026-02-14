import { debug } from '../utils/debug.ts';
import { CraftTicketProvider } from './providers/craft-provider.ts';
import { GitHubTicketProvider } from './providers/github-provider.ts';
import { LocalTicketProvider } from './providers/local-provider.ts';
import type {
  SyncResult,
  Ticket,
  TicketConfig,
  TicketFilter,
  TicketProvider,
  TicketProviderConfig,
  TicketProviderType,
  TicketStatus,
} from './types.ts';

class UnavailableLinearTicketProvider implements TicketProvider {
  readonly type = 'linear' as const;
  readonly name = 'Linear (Unavailable)';

  async listTickets(_filter?: TicketFilter): Promise<Ticket[]> { return []; }
  async getTicket(_ticketId: string): Promise<Ticket | null> { return null; }
  async updateTicketStatus(_ticketId: string, _status: TicketStatus): Promise<void> {
    throw new Error('Linear provider is configured but not yet implemented in this build.');
  }
  async linkToRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Linear provider is configured but not yet implemented in this build.');
  }
  async unlinkFromRequirement(_ticketId: string, _requirementId: string): Promise<void> {
    throw new Error('Linear provider is configured but not yet implemented in this build.');
  }
  async getTicketsForRequirement(_requirementId: string): Promise<Ticket[]> { return []; }
  async sync(): Promise<SyncResult> {
    return {
      added: 0,
      updated: 0,
      removed: 0,
      errors: ['Linear provider is configured but not yet implemented in this build.'],
      lastSyncAt: new Date().toISOString(),
    };
  }
  isAuthenticated(): boolean { return false; }
}

export class TicketService {
  private readonly providers = new Map<TicketProviderType, TicketProvider>();

  constructor(
    private readonly config: TicketConfig,
    private readonly workspaceRoot: string
  ) {
    this.initializeProviders(config.providers ?? []);
  }

  async getAllTickets(filter?: TicketFilter): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    const providers = this.getProviderInstances();

    await Promise.all(
      providers.map(async (provider) => {
        try {
          tickets.push(...(await provider.listTickets(filter)));
        } catch (error) {
          debug(`[TicketService] Failed to list tickets for ${provider.type}:`, error);
        }
      })
    );

    return tickets.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getTicket(provider: TicketProviderType, ticketId: string): Promise<Ticket | null> {
    const ticketProvider = this.providers.get(provider);
    if (!ticketProvider) return null;
    return ticketProvider.getTicket(ticketId);
  }

  async syncAll(): Promise<Map<TicketProviderType, SyncResult>> {
    const results = new Map<TicketProviderType, SyncResult>();

    await Promise.all(
      this.getProviderInstances().map(async (provider) => {
        try {
          results.set(provider.type, await provider.sync());
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          results.set(provider.type, {
            added: 0,
            updated: 0,
            removed: 0,
            errors: [message],
            lastSyncAt: new Date().toISOString(),
          });
        }
      })
    );

    return results;
  }

  async getRequirementTickets(requirementId: string): Promise<Ticket[]> {
    const tickets: Ticket[] = [];
    await Promise.all(
      this.getProviderInstances().map(async (provider) => {
        try {
          tickets.push(...(await provider.getTicketsForRequirement(requirementId)));
        } catch (error) {
          debug(`[TicketService] Failed requirement lookup on ${provider.type}:`, error);
        }
      })
    );
    return tickets;
  }

  async autoLinkByTitle(
    requirements: Array<{ id: string; description: string }>
  ): Promise<Map<string, string[]>> {
    const links = new Map<string, string[]>();
    if (!this.config.autoLink || requirements.length === 0) return links;

    const tickets = await this.getAllTickets();
    for (const requirement of requirements) {
      const matches = tickets.filter((ticket) => this.matchesRequirementByTitle(ticket, requirement.description));
      if (matches.length === 0) continue;

      links.set(requirement.id, matches.map((ticket) => `${ticket.provider}:${ticket.id}`));
      await Promise.all(
        matches.map(async (ticket) => {
          const provider = this.providers.get(ticket.provider);
          if (!provider) return;
          try {
            await provider.linkToRequirement(ticket.id, requirement.id);
          } catch (error) {
            debug(
              `[TicketService] Failed auto-link ${ticket.provider}:${ticket.id} -> ${requirement.id}:`,
              error
            );
          }
        })
      );
    }

    return links;
  }

  getProvider(type: TicketProviderType): TicketProvider | undefined {
    return this.providers.get(type);
  }

  getConfiguredProviders(): TicketProviderType[] {
    return Array.from(this.providers.keys());
  }

  private getProviderInstances(): TicketProvider[] {
    return Array.from(this.providers.values());
  }

  private initializeProviders(providerConfigs: TicketProviderConfig[]): void {
    for (const providerConfig of providerConfigs) {
      if (!providerConfig.enabled) continue;

      try {
        const provider = this.createProvider(providerConfig);
        if (provider) {
          this.providers.set(provider.type, provider);
        }
      } catch (error) {
        debug(`[TicketService] Failed to initialize provider ${providerConfig.type}:`, error);
      }
    }
  }

  private createProvider(config: TicketProviderConfig): TicketProvider | null {
    switch (config.type) {
      case 'local':
        return new LocalTicketProvider(this.workspaceRoot, config.local?.storagePath);

      case 'github':
        if (!config.github?.owner || !config.github?.repo) {
          throw new Error('GitHub provider requires owner and repo');
        }
        return new GitHubTicketProvider(this.workspaceRoot, config.github);

      case 'craft':
        return new CraftTicketProvider(this.workspaceRoot, config.craft);

      case 'linear':
        debug('[TicketService] Linear provider configured but not implemented yet; using unavailable placeholder provider');
        return new UnavailableLinearTicketProvider();

      default:
        return null;
    }
  }

  private matchesRequirementByTitle(ticket: Ticket, requirementDescription: string): boolean {
    const req = requirementDescription.trim().toLowerCase();
    if (!req) return false;

    const title = ticket.title.trim().toLowerCase();
    if (!title) return false;

    if (title.includes(req) || req.includes(title)) {
      return true;
    }

    const reqTokens = new Set(req.split(/\W+/).filter((token) => token.length > 3));
    if (reqTokens.size === 0) return false;

    const titleTokens = title.split(/\W+/).filter((token) => token.length > 3);
    const overlap = titleTokens.filter((token) => reqTokens.has(token)).length;
    return overlap >= Math.min(3, Math.ceil(titleTokens.length * 0.5));
  }
}

