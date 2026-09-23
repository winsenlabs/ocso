import { and, eq, isNull } from 'drizzle-orm';
import type { ToolProviderFactory } from '@ocso/agent-runtime';
import {
  SecretCredentialPort,
  connectionTarget,
  egressPolicyFor,
  recordConnectionAuthFailure,
  type ConnectionRow,
  type SettingsService,
} from '@ocso/application';
import { notFound } from '@ocso/domain';
import { mcpConnections, tools, type Db } from '@ocso/db';
import { McpToolProvider, type ApprovedToolDefinition, type DnsResolver, type EgressLimits } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';
import type { ToolProvider } from '@ocso/tools';

export interface McpToolProviderFactoryOptions {
  resolver?: DnsResolver | undefined;
  limits?: Partial<EgressLimits> | undefined;
  /** Connect/negotiation deadline per pooled client. Default 10 s. */
  connectTimeoutMs?: number | undefined;
  /** How long the egress allowlist from deployment settings is reused. Default 10 s. */
  settingsTtlMs?: number | undefined;
  /** Grace period before a replaced provider is closed, so in-flight calls finish. Default 30 s. */
  closeGraceMs?: number | undefined;
}

interface CacheEntry {
  /** Connection `updatedAt` + network + egress allowlist the provider was built from. */
  key: string;
  provider: McpToolProvider;
  port: SecretCredentialPort;
  tokenRef: string | null;
  stale: boolean;
}

/**
 * Runtime ToolProviderFactory (agent-runtime ToolRunner): one pooled
 * McpToolProvider per connection, rebuilt whenever the connection row changes
 * (`updatedAt`: credentials, approvals, status) or the egress allowlist does.
 * Credentials are resolved through the SecretStore; refreshed OAuth tokens
 * are persisted by compare-and-swap so concurrent workers never lose a
 * rotated refresh token — the loser drops its session and re-reads.
 */
export class McpToolProviderFactory implements ToolProviderFactory {
  private readonly cache = new Map<string, Promise<CacheEntry>>();
  private hosts: { value: string[]; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly secrets: SecretStore,
    private readonly settings: SettingsService,
    private readonly options: McpToolProviderFactoryOptions = {},
  ) {}

  async forConnection(connectionId: string): Promise<ToolProvider> {
    const [row] = await this.db.select().from(mcpConnections).where(eq(mcpConnections.id, connectionId));
    if (!row) throw notFound('mcp_connection', connectionId);
    const hosts = await this.internalHosts();
    const key = `${row.updatedAt.getTime()}|${row.network}|${hosts.join(',')}`;

    for (;;) {
      const cached = this.cache.get(connectionId);
      if (!cached) break;
      const entry = await cached.catch(() => null);
      if (this.cache.get(connectionId) !== cached) continue; // replaced while we waited
      if (entry && entry.key === key && !entry.stale) return entry.provider;
      this.cache.delete(connectionId);
      if (entry) this.retire(entry.provider);
      break;
    }
    const building = this.build(row, key, hosts);
    this.cache.set(connectionId, building);
    building.catch(() => {
      if (this.cache.get(connectionId) === building) this.cache.delete(connectionId);
    });
    return (await building).provider;
  }

  /** Drop a connection's pooled client (e.g. after an admin change observed out of band). */
  invalidate(connectionId: string): void {
    const cached = this.cache.get(connectionId);
    this.cache.delete(connectionId);
    void cached?.then((e) => e.provider.close()).catch(() => undefined);
  }

  async close(): Promise<void> {
    const entries = [...this.cache.values()];
    this.cache.clear();
    await Promise.all(entries.map((p) => p.then((e) => e.provider.close()).catch(() => undefined)));
  }

  private async build(row: ConnectionRow, key: string, hosts: string[]): Promise<CacheEntry> {
    const approved = await this.db
      .select({ name: tools.name, inputSchema: tools.inputSchema, outputSchema: tools.outputSchema })
      .from(tools)
      .where(and(eq(tools.connectionId, row.id), eq(tools.approved, true), isNull(tools.removedAt)));
    const definitions = new Map<string, ApprovedToolDefinition>(
      approved.map((t) => [t.name, { name: t.name, inputSchema: t.inputSchema, ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}) }]),
    );
    const holder: { entry?: CacheEntry } = {};
    const port = new SecretCredentialPort(this.db, this.secrets, {
      // Another worker rotated the tokens first: re-read the winner's state on next use.
      onSuperseded: () => {
        if (holder.entry) holder.entry.stale = true;
      },
    });
    const provider = new McpToolProvider({
      target: connectionTarget(row),
      deps: { credentials: port, egress: egressPolicyFor(hosts, row.network), resolver: this.options.resolver, limits: this.options.limits },
      trusted: row.sendCustomerClaims,
      forwardUserToken: row.forwardUserToken,
      approvedTool: (name) => definitions.get(name),
      connectTimeoutMs: this.options.connectTimeoutMs,
      onAuthFailure: (id) => void this.onAuthFailure(id, holder.entry),
    });
    holder.entry = { key, provider, port, tokenRef: row.tokenRef, stale: false };
    return holder.entry;
  }

  /**
   * The server rejected our credentials. If the stored secret moved on since
   * this provider read it (another worker refreshed), just re-read next time;
   * otherwise the grant is dead and the connection needs re-authentication.
   */
  private async onAuthFailure(connectionId: string, entry: CacheEntry | undefined): Promise<void> {
    if (!entry) return;
    entry.stale = true;
    try {
      if (entry.tokenRef && (await entry.port.isStale(entry.tokenRef))) return;
      await recordConnectionAuthFailure(this.db, connectionId, `mcp-auth-failure-${connectionId}`);
    } catch {
      // Best effort: the next health check reaches the same conclusion.
    }
  }

  private retire(provider: McpToolProvider): void {
    const timer = setTimeout(() => void provider.close().catch(() => undefined), this.options.closeGraceMs ?? 30_000);
    timer.unref();
  }

  private async internalHosts(): Promise<string[]> {
    const ttl = this.options.settingsTtlMs ?? 10_000;
    if (this.hosts && Date.now() - this.hosts.at < ttl) return this.hosts.value;
    const deployment = await this.settings.deployment();
    this.hosts = { value: [...deployment.egressAllowedInternalHosts].sort(), at: Date.now() };
    return this.hosts.value;
  }
}

/** Registry key of the MCP connection tool source (the `@ocso/mcp` plugin in FIRST_PARTY_PLUGINS). */
export const MCP_TOOL_SOURCE = 'mcp';
