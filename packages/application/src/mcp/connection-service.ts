import { and, asc, eq, isNull } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { mcpConnections, tools, uuidv7, type Db } from '@ocso/db';
import { assertUrlAllowed, type DnsResolver, type EgressLimits, type HealthOptions } from '@ocso/mcp';
import type { SecretStore } from '@ocso/secrets';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanView, requirePermission } from './access.js';
import { ConnectionAuthFlow, type OAuthBegun, type OAuthCompleted } from './auth-flow.js';
import { ConnectionAdmin } from './connection-admin.js';
import { ConnectionReview } from './connection-review.js';
import { ConnectionDiscovery, type DiscoveryOutcome } from './discovery-runner.js';
import { loadEgressPolicy } from './egress.js';
import { connectionNameTaken } from './errors.js';
import { McpHealthMonitor, type HealthCheckOutcome, type HealthSampleView } from './health-monitor.js';
import {
  CreateConnectionInput,
  HeaderAuthInput,
  type ApproveConnectionInput,
  type BeginOAuthInput,
  type ClassifyToolsInput,
  type OAuthCallbackInput,
} from './inputs.js';
import { isUniqueViolation, loadConnection, type McpContext } from './records.js';
import { stageSecrets, unstageSecrets } from '../settings/secret-refs.js';
import { toToolView, viewOf, viewsOf, type ConnectionView, type ToolView } from './views.js';

export interface McpConnectionServiceDeps {
  db: Db;
  secrets: SecretStore;
  /** OCSO_PUBLIC_URL; the OAuth redirect URI is `${publicUrl}/oauth/mcp/callback`. */
  publicUrl: string;
  now?: (() => Date) | undefined;
  /** DNS override (tests / custom resolvers). */
  resolver?: DnsResolver | undefined;
  limits?: Partial<EgressLimits> | undefined;
  discoveryTimeoutMs?: number | undefined;
  health?: HealthOptions | undefined;
  oauthPendingTtlMs?: number | undefined;
}

export const oauthRedirectUri = (publicUrl: string): string => `${publicUrl.replace(/\/+$/, '')}/oauth/mcp/callback`;

/**
 * MCP connection manager (docs/08 §2, design/04 "Add MCP server"): Enter URL
 * → Discover → Authenticate → Review capabilities → Approve → Active, plus
 * re-discovery, enable/disable/delete and health. One facade over small
 * collaborators; every operation is authorized here, audited, and
 * invalidates affected agents' tool catalogues.
 */
export class McpConnectionService {
  private readonly ctx: McpContext;
  private readonly discovery: ConnectionDiscovery;
  private readonly auth: ConnectionAuthFlow;
  private readonly review: ConnectionReview;
  private readonly admin: ConnectionAdmin;
  readonly health: McpHealthMonitor;

  constructor(deps: McpConnectionServiceDeps) {
    this.ctx = {
      db: deps.db,
      secrets: deps.secrets,
      now: deps.now ?? (() => new Date()),
      redirectUri: oauthRedirectUri(deps.publicUrl),
      resolver: deps.resolver,
      limits: deps.limits,
      discoveryTimeoutMs: deps.discoveryTimeoutMs,
      health: deps.health,
      oauthPendingTtlMs: deps.oauthPendingTtlMs,
    };
    this.discovery = new ConnectionDiscovery(this.ctx);
    this.auth = new ConnectionAuthFlow(this.ctx, this.discovery);
    this.review = new ConnectionReview(this.ctx);
    this.admin = new ConnectionAdmin(this.ctx, this.auth.pendingStore);
    this.health = new McpHealthMonitor(this.ctx);
  }

  /** Shared connections and USER-scope templates (personal instances are listed per owner). */
  async list(actor: ActorContext): Promise<ConnectionView[]> {
    requirePermission(actor, Permission.MCP_READ);
    const rows = await this.ctx.db.select().from(mcpConnections).where(isNull(mcpConnections.ownerUserId)).orderBy(asc(mcpConnections.name));
    return viewsOf(this.ctx.db, rows);
  }

  async get(actor: ActorContext, id: string): Promise<ConnectionView> {
    const row = await loadConnection(this.ctx.db, id);
    assertCanView(actor, row);
    return viewOf(this.ctx.db, row);
  }

  async listTools(actor: ActorContext, id: string, options: { includeRemoved?: boolean } = {}): Promise<ToolView[]> {
    assertCanView(actor, await loadConnection(this.ctx.db, id));
    const rows = await this.ctx.db
      .select()
      .from(tools)
      .where(options.includeRemoved ? eq(tools.connectionId, id) : and(eq(tools.connectionId, id), isNull(tools.removedAt)))
      .orderBy(asc(tools.name));
    return rows.map(toToolView);
  }

  /** Step 1 "Enter URL": a PENDING draft. The URL is checked against the egress policy up front. */
  async createDraft(actor: ActorContext, raw: CreateConnectionInput): Promise<ConnectionView> {
    const principal = requirePermission(actor, Permission.MCP_MANAGE);
    const input = CreateConnectionInput.parse(raw);
    assertUrlAllowed(new URL(input.url), await loadEgressPolicy(this.ctx.db, input.network), input.network);
    const id = uuidv7();
    const now = this.ctx.now();
    try {
      return await this.ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(mcpConnections)
          .values({
            id,
            name: input.name,
            description: input.description ?? null,
            url: input.url,
            network: input.network,
            scope: input.scope,
            status: 'PENDING',
            createdBy: principal.userId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await recordAudit(tx, actor, {
          action: 'mcp.connection.create',
          targetType: 'mcp_connection',
          targetId: id,
          summary: `Added MCP server ${input.name} (${input.scope === 'USER' ? 'user-scoped template' : 'shared'})`,
          after: input,
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
        return viewOf(tx, row!);
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw connectionNameTaken(input.name);
      throw err;
    }
  }

  discover(actor: ActorContext, id: string): Promise<DiscoveryOutcome> {
    return this.discovery.run(actor, id, 'discover');
  }

  rediscover(actor: ActorContext, id: string): Promise<DiscoveryOutcome> {
    return this.discovery.run(actor, id, 'rediscover');
  }

  setHeaderAuth(actor: ActorContext, id: string, input: HeaderAuthInput): Promise<DiscoveryOutcome> {
    return this.auth.setHeaderAuth(actor, id, input);
  }

  beginOAuth(actor: ActorContext, id: string, input: BeginOAuthInput): Promise<OAuthBegun> {
    return this.auth.beginOAuth(actor, id, input);
  }

  /** Public OAuth callback; throws `McpOAuthCallbackError` (stable `reason`, never token material). */
  completeOAuth(query: OAuthCallbackInput, correlationId: string): Promise<OAuthCompleted> {
    return this.auth.completeOAuth(query, correlationId);
  }

  classifyTools(actor: ActorContext, id: string, input: ClassifyToolsInput): Promise<ToolView[]> {
    return this.review.classifyTools(actor, id, input);
  }

  /** Records a draft's agent policy (the ACTIVATE proposal takes it live); 409 approval_required once approved. */
  approve(actor: ActorContext, id: string, input: ApproveConnectionInput): Promise<ConnectionView> {
    return this.review.approve(actor, id, input);
  }

  /** Personal connections are one user's credentials and never proposals; shared ones and templates are. */
  async isGoverned(actor: ActorContext, id: string): Promise<boolean> {
    const row = await loadConnection(this.ctx.db, id);
    assertCanView(actor, row);
    return row.ownerUserId === null;
  }

  /**
   * The payload of an UPDATE proposal carrying a new header credential: the token is stored as a NEW secret
   * (the live connection keeps its credential until approval) and travels as its ref only.
   */
  async stageHeaderCredential(actor: ActorContext, id: string, raw: HeaderAuthInput): Promise<{ payload: Record<string, unknown>; discard: () => Promise<void> }> {
    const input = HeaderAuthInput.parse(raw);
    const row = await loadConnection(this.ctx.db, id);
    requirePermission(actor, Permission.MCP_MANAGE);
    const owner = { kind: 'mcp_connection', objectId: row.id, makerId: actor.principal!.userId };
    const [staged] = await stageSecrets(this.ctx.db, this.ctx.secrets, owner, { name: `mcp ${row.name}`, kind: () => 'API_KEY', usedBy: `mcp:${row.name}` }, { [input.headerName]: input.token });
    return { payload: { headerCredential: { headerName: input.headerName, ref: staged!.ref } }, discard: () => unstageSecrets(this.ctx.db, this.ctx.secrets, [staged!.ref]) };
  }

  disable(actor: ActorContext, id: string): Promise<ConnectionView> {
    return this.admin.disable(actor, id);
  }

  enable(actor: ActorContext, id: string): Promise<ConnectionView> {
    return this.admin.enable(actor, id);
  }

  delete(actor: ActorContext, id: string): Promise<void> {
    return this.admin.delete(actor, id);
  }

  /** Manual health check (UI). */
  checkHealth(actor: ActorContext, id: string): Promise<HealthCheckOutcome> {
    return this.health.check(actor, id);
  }

  /** System health check of one connection (scheduler / tests). */
  runHealthCheck(id: string): Promise<HealthCheckOutcome> {
    return this.health.runHealthCheck(id);
  }

  /**
   * Worker scheduler entry point: every connection whose check interval has
   * elapsed. Also sweeps expired OAuth pending records and their secrets.
   */
  async runDueHealthChecks(options?: { limit?: number; concurrency?: number }): Promise<HealthCheckOutcome[]> {
    await this.auth.pendingStore.purgeExpired().catch(() => 0);
    return this.health.runDueHealthChecks(options);
  }

  healthHistory(actor: ActorContext, id: string, limit?: number): Promise<HealthSampleView[]> {
    return this.health.history(actor, id, limit);
  }
}
