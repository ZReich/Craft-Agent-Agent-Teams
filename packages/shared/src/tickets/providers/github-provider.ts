import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { readJsonFileSync } from '../../utils/files.ts';
import type {
  RequirementLinkMap,
  SyncResult,
  Ticket,
  TicketFilter,
  TicketProvider,
  TicketProviderConfig,
  TicketStatus,
} from '../types.ts';
import { debug } from '../../utils/debug.ts';

interface GitHubIssue {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'open' | 'closed';
  body?: string;
  assignees?: Array<{ login: string }>;
  labels?: Array<{ name: string }>;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface GitHubTicketCache {
  lastSyncAt: string;
  tickets: Ticket[];
}

const CACHE_FILE = join('tickets', 'github-cache.json');
const REQUIREMENT_LINKS_FILE = join('tickets', 'github-requirement-links.json');

export class GitHubTicketProvider implements TicketProvider {
  readonly type = 'github' as const;
  readonly name = 'GitHub Issues';

  private readonly cachePath: string;
  private readonly linksPath: string;

  constructor(
    private readonly workspaceRoot: string,
    private readonly config: NonNullable<TicketProviderConfig['github']>
  ) {
    this.cachePath = join(workspaceRoot, CACHE_FILE);
    this.linksPath = join(workspaceRoot, REQUIREMENT_LINKS_FILE);
    this.ensureStorageFiles();
  }

  async listTickets(filter?: TicketFilter): Promise<Ticket[]> {
    try {
      const issues = this.fetchIssues(filter?.limit);
      const links = this.loadRequirementLinks();
      const tickets = this.applyFilter(
        issues.map((issue) => this.mapIssueToTicket(issue, links)),
        filter
      );
      return tickets;
    } catch (error) {
      debug('[GitHubTicketProvider] listTickets failed, falling back to cache:', error);
      const cached = this.loadCache().tickets;
      return this.applyFilter(cached, filter);
    }
  }

  async getTicket(ticketId: string): Promise<Ticket | null> {
    try {
      const issue = this.fetchIssue(ticketId);
      return this.mapIssueToTicket(issue, this.loadRequirementLinks());
    } catch {
      return this.loadCache().tickets.find(
        (ticket) => ticket.id === ticketId || ticket.externalId === ticketId
      ) ?? null;
    }
  }

  async updateTicketStatus(ticketId: string, status: TicketStatus): Promise<void> {
    const normalizedId = this.normalizeTicketId(ticketId);
    if (normalizedId === null) {
      throw new Error(`Invalid GitHub issue id: ${ticketId}`);
    }

    if (status === 'closed' || status === 'cancelled') {
      this.runGhCommand(['issue', 'close', String(normalizedId), '--repo', this.repoArg]);
      return;
    }

    // GitHub supports open/closed state only. "in-progress" maps to "open".
    this.runGhCommand(['issue', 'reopen', String(normalizedId), '--repo', this.repoArg]);
  }

  async linkToRequirement(ticketId: string, requirementId: string): Promise<void> {
    const id = this.toExternalId(ticketId);
    const links = this.loadRequirementLinks();
    const existing = links[id] ?? [];
    if (!existing.includes(requirementId)) {
      links[id] = [...existing, requirementId];
      this.saveRequirementLinks(links);
    }
  }

  async unlinkFromRequirement(ticketId: string, requirementId: string): Promise<void> {
    const id = this.toExternalId(ticketId);
    const links = this.loadRequirementLinks();
    const existing = links[id] ?? [];
    const next = existing.filter((value) => value !== requirementId);

    if (next.length > 0) {
      links[id] = next;
    } else {
      delete links[id];
    }
    this.saveRequirementLinks(links);
  }

  async getTicketsForRequirement(requirementId: string): Promise<Ticket[]> {
    const tickets = await this.listTickets();
    return tickets.filter((ticket) => ticket.requirementIds?.includes(requirementId));
  }

  async sync(): Promise<SyncResult> {
    const now = new Date().toISOString();
    try {
      const oldCache = this.loadCache();
      const links = this.loadRequirementLinks();
      const latest = this.fetchIssues(undefined).map((issue) => this.mapIssueToTicket(issue, links));

      const previousById = new Map(oldCache.tickets.map((ticket) => [ticket.id, ticket]));
      const latestById = new Map(latest.map((ticket) => [ticket.id, ticket]));

      let added = 0;
      let updated = 0;
      let removed = 0;

      for (const [id, ticket] of latestById) {
        const previous = previousById.get(id);
        if (!previous) {
          added += 1;
          continue;
        }
        if (
          previous.updatedAt !== ticket.updatedAt ||
          previous.status !== ticket.status ||
          previous.title !== ticket.title
        ) {
          updated += 1;
        }
      }

      for (const id of previousById.keys()) {
        if (!latestById.has(id)) {
          removed += 1;
        }
      }

      this.saveCache({ lastSyncAt: now, tickets: latest });
      return { added, updated, removed, errors: [], lastSyncAt: now };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        added: 0,
        updated: 0,
        removed: 0,
        errors: [message],
        lastSyncAt: now,
      };
    }
  }

  isAuthenticated(): boolean {
    const auth = spawnSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      cwd: this.workspaceRoot,
      env: this.getGhEnv(),
    });
    return auth.status === 0;
  }

  getAuthUrl(): string {
    return 'https://cli.github.com/manual/gh_auth_login';
  }

  private get repoArg(): string {
    return `${this.config.owner}/${this.config.repo}`;
  }

  private ensureStorageFiles(): void {
    const ticketsDir = join(this.workspaceRoot, 'tickets');
    if (!existsSync(ticketsDir)) {
      mkdirSync(ticketsDir, { recursive: true });
    }
    if (!existsSync(this.cachePath)) {
      this.saveCache({ lastSyncAt: new Date(0).toISOString(), tickets: [] });
    }
    if (!existsSync(this.linksPath)) {
      this.saveRequirementLinks({});
    }
  }

  private fetchIssues(limit?: number): GitHubIssue[] {
    const args = [
      'issue',
      'list',
      '--repo',
      this.repoArg,
      '--state',
      'all',
      '--json',
      'number,title,state,body,assignees,labels,url,createdAt,updatedAt',
      '--limit',
      String(limit && limit > 0 ? limit : 100),
    ];

    const output = this.runGhCommand(args);
    const parsed = JSON.parse(output) as GitHubIssue[];
    return Array.isArray(parsed) ? parsed : [];
  }

  private fetchIssue(ticketId: string): GitHubIssue {
    const normalizedId = this.normalizeTicketId(ticketId);
    if (normalizedId === null) {
      throw new Error(`Invalid GitHub issue id: ${ticketId}`);
    }

    const output = this.runGhCommand([
      'issue',
      'view',
      String(normalizedId),
      '--repo',
      this.repoArg,
      '--json',
      'number,title,state,body,assignees,labels,url,createdAt,updatedAt',
    ]);

    return JSON.parse(output) as GitHubIssue;
  }

  private runGhCommand(args: string[]): string {
    const result = spawnSync('gh', args, {
      encoding: 'utf8',
      cwd: this.workspaceRoot,
      env: this.getGhEnv(),
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || 'gh command failed').trim());
    }

    return (result.stdout || '').trim();
  }

  private getGhEnv(): NodeJS.ProcessEnv {
    if (!this.config.token) return process.env;
    return {
      ...process.env,
      GH_TOKEN: this.config.token,
      GITHUB_TOKEN: this.config.token,
    };
  }

  private mapIssueToTicket(issue: GitHubIssue, links: RequirementLinkMap): Ticket {
    const labels = (issue.labels ?? []).map((label) => label.name);
    const externalId = String(issue.number);
    return {
      id: externalId,
      provider: 'github',
      externalId,
      title: issue.title,
      description: issue.body,
      status: this.mapIssueStatus(issue.state, labels),
      url: issue.url,
      assignee: issue.assignees?.[0]?.login,
      labels,
      requirementIds: links[externalId] ?? [],
      createdAt: issue.createdAt ?? new Date().toISOString(),
      updatedAt: issue.updatedAt ?? issue.createdAt ?? new Date().toISOString(),
      metadata: { github: issue },
    };
  }

  private mapIssueStatus(state: GitHubIssue['state'], labels: string[]): TicketStatus {
    const closed = String(state).toLowerCase() === 'closed';
    const normalizedLabels = labels.map((label) => label.toLowerCase());

    if (closed && normalizedLabels.includes('cancelled')) {
      return 'cancelled';
    }
    if (closed) {
      return 'closed';
    }
    if (
      normalizedLabels.includes('in-progress') ||
      normalizedLabels.includes('in progress') ||
      normalizedLabels.includes('in_progress')
    ) {
      return 'in-progress';
    }
    return 'open';
  }

  private normalizeTicketId(ticketId: string): number | null {
    const numeric = Number.parseInt(this.toExternalId(ticketId), 10);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private toExternalId(ticketId: string): string {
    if (/^\d+$/.test(ticketId)) return ticketId;
    const cached = this.loadCache().tickets.find((ticket) => ticket.id === ticketId);
    return cached?.externalId ?? ticketId;
  }

  private loadRequirementLinks(): RequirementLinkMap {
    this.ensureStorageFiles();
    try {
      const links = readJsonFileSync<RequirementLinkMap>(this.linksPath);
      return links && typeof links === 'object' ? links : {};
    } catch {
      return {};
    }
  }

  private saveRequirementLinks(links: RequirementLinkMap): void {
    this.ensureParentDir(this.linksPath);
    writeFileSync(this.linksPath, JSON.stringify(links, null, 2), 'utf-8');
  }

  private loadCache(): GitHubTicketCache {
    this.ensureStorageFiles();
    try {
      const cache = readJsonFileSync<GitHubTicketCache>(this.cachePath);
      if (!cache || !Array.isArray(cache.tickets)) {
        return { lastSyncAt: new Date(0).toISOString(), tickets: [] };
      }
      return cache;
    } catch {
      return { lastSyncAt: new Date(0).toISOString(), tickets: [] };
    }
  }

  private saveCache(cache: GitHubTicketCache): void {
    this.ensureParentDir(this.cachePath);
    writeFileSync(this.cachePath, JSON.stringify(cache, null, 2), 'utf-8');
  }

  private ensureParentDir(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  private applyFilter(tickets: Ticket[], filter?: TicketFilter): Ticket[] {
    if (!filter) return tickets;

    const normalizedSearch = filter.search?.trim().toLowerCase();
    const filtered = tickets.filter((ticket) => {
      if (filter.status?.length && !filter.status.includes(ticket.status)) return false;
      if (filter.assignee && ticket.assignee !== filter.assignee) return false;
      if (filter.labels?.length) {
        const labelSet = new Set(ticket.labels ?? []);
        if (!filter.labels.every((label) => labelSet.has(label))) return false;
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

