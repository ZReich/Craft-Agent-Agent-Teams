/**
 * Tickets module public exports.
 */

// Types
export type {
  Ticket,
  TicketConfig,
  TicketFilter,
  TicketProvider,
  TicketProviderConfig,
  TicketProviderType,
  TicketStatus,
  SyncResult,
} from './types.ts';

// Service
export { TicketService } from './service.ts';

// Providers
export { LocalTicketProvider } from './providers/local-provider.ts';
export type { CreateLocalTicketInput } from './providers/local-provider.ts';
export { GitHubTicketProvider } from './providers/github-provider.ts';
export { CraftTicketProvider } from './providers/craft-provider.ts';

