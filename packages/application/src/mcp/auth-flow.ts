import { eq } from 'drizzle-orm';
import { forbidden } from '@ocso/domain';
import { mcpConnections, type DbOrTx } from '@ocso/db';
import {
  McpOAuthError,
  McpOAuthService,
  parseClientInformation,
  serializeClientInformation,
  serializeOAuthTokenState,
  type CompleteAuthorizationResult,
  type McpOAuthClientInformation,
} from '@ocso/mcp';
import { recordAudit } from '../audit/audit.js';
import { loadPrincipal } from '../identity/sessions.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanOperate } from './access.js';
import type { ConnectionDiscovery, DiscoveryOutcome } from './discovery-runner.js';
import { loadEgressPolicy } from './egress.js';
import { callbackFailure, connectionDisabled } from './errors.js';
import { BeginOAuthInput, HeaderAuthInput, OAuthCallbackInput } from './inputs.js';
import { OAuthPendingStore } from './pending-store.js';
import { assertUnlocked, approvalRequiredError } from '../approvals/guard.js';
import { assertPlatformWrite, lockPlatformObject, platformGoverned } from '../settings/platform-approvals.js';
import { connectionTarget, isPersonal, loadConnection, revokeSecrets, type ConnectionRow, type McpContext } from './records.js';

export interface OAuthBegun {
  authorizationUrl: string;
  expiresAt: string;
}

export interface OAuthCompleted {
  connectionId: string;
  /** Re-discovery after authorization; null when it failed (see `discoveryError` and the connection's lastError). */
  discovery: DiscoveryOutcome | null;
  discoveryError: string | null;
}

/**
 * Wizard step 3 "Authenticate": a static header token, or the server-side
 * OAuth 2.1 redirect flow (ADR-021). Credentials go to the SecretStore; the
 * connection row and the audit trail only ever hold reference ids.
 */
export class ConnectionAuthFlow {
  private readonly pending: OAuthPendingStore;

  constructor(
    private readonly ctx: McpContext,
    private readonly discovery: ConnectionDiscovery,
  ) {
    this.pending = new OAuthPendingStore(ctx.db, ctx.secrets, ctx.now);
  }

  get pendingStore(): OAuthPendingStore {
    return this.pending;
  }

  async setHeaderAuth(actor: ActorContext, id: string, raw: HeaderAuthInput): Promise<DiscoveryOutcome> {
    const input = HeaderAuthInput.parse(raw);
    const row = await this.operable(actor, id);
    // Maker–checker: a header credential on an approved shared connection is an UPDATE proposal (409 here).
    const governed = !isPersonal(row);
    if (governed) await this.ctx.db.transaction((tx) => assertPlatformWrite(tx, 'mcp_connection', id));
    const meta = await this.ctx.secrets.put({ name: `mcp ${row.name} ${input.headerName}`, kind: 'API_KEY', value: input.token, usedBy: `mcp:${row.name}` });
    await this.swapCredentials(actor, row, [meta.ref], {
      values: { authStrategy: 'HEADER', authConfig: { headerName: input.headerName }, tokenRef: meta.ref, clientInfoRef: null, grantedScopes: [] },
      action: 'mcp.connection.auth_header',
      summary: `Set ${input.headerName} header credential on ${row.name}`,
      after: { headerName: input.headerName, credentialRef: meta.ref },
      guard: governed ? (tx) => assertPlatformWrite(tx, 'mcp_connection', row.id) : undefined,
    });
    return this.discovery.run(actor, id);
  }

  async beginOAuth(actor: ActorContext, id: string, raw: BeginOAuthInput): Promise<OAuthBegun> {
    const input = BeginOAuthInput.parse(raw);
    const row = await this.operable(actor, id);
    const principal = actor.principal!;
    // A governed connection may only be re-authorized (the same OAuth server and client); anything else is an approval.
    if (!isPersonal(row)) await this.ctx.db.transaction((tx) => assertOAuthAllowed(tx, row, null));
    const oauth = await this.oauthService(row.network);
    const existingClient = await this.existingClient(row);
    const begun = await oauth.beginAuthorization(connectionTarget(row), {
      redirectUri: this.ctx.redirectUri,
      ...(input.clientMetadataUrl ? { clientMetadataUrl: input.clientMetadataUrl } : {}),
      ...(input.clientId ? { preRegistered: { clientId: input.clientId, clientSecret: input.clientSecret } } : {}),
      ...(existingClient ? { existingClient } : {}),
      ...(input.scopes?.length ? { scopes: input.scopes } : {}),
      ...(input.authorizationServer ? { authorizationServer: input.authorizationServer } : {}),
    });
    await this.pending.save(principal.userId, begun.pending);
    const expiresAt = new Date(begun.pending.expiresAt).toISOString();
    await this.ctx.db.transaction(async (tx) => {
      await recordAudit(tx, actor, {
        action: 'mcp.connection.oauth_begin',
        targetType: 'mcp_connection',
        targetId: id,
        summary: `Started OAuth authorization for ${row.name} with ${begun.pending.issuer}`,
        after: { issuer: begun.pending.issuer, registration: begun.pending.clientInformation.registration, scopes: begun.pending.scopes, expiresAt },
      });
    });
    return { authorizationUrl: begun.authorizationUrl, expiresAt };
  }

  /** Public callback leg. Every failure becomes `McpOAuthCallbackError` with a stable reason code. */
  async completeOAuth(raw: OAuthCallbackInput, correlationId: string): Promise<OAuthCompleted> {
    const query = OAuthCallbackInput.safeParse(raw);
    if (!query.success || !query.data.state) throw callbackFailure(new McpOAuthError('state_mismatch'), null);
    const taken = await this.pending.take(query.data.state);
    if (!taken) throw callbackFailure(new McpOAuthError('state_mismatch'), null);
    const connectionId = taken.row.connectionId;
    const actor = await this.completeGrant(taken, query.data, correlationId);
    try {
      return { connectionId, discovery: await this.discovery.run(actor, connectionId), discoveryError: null };
    } catch (err) {
      return { connectionId, discovery: null, discoveryError: callbackFailure(err, connectionId).reason };
    }
  }

  private async completeGrant(
    taken: NonNullable<Awaited<ReturnType<OAuthPendingStore['take']>>>,
    query: OAuthCallbackInput,
    correlationId: string,
  ): Promise<ActorContext> {
    const connectionId = taken.row.connectionId;
    let actor: ActorContext | null = null;
    try {
      if (!taken.pending || taken.pending.connectionId !== connectionId) throw new McpOAuthError('state_mismatch');
      actor = await this.actorFor(taken.row.userId, correlationId);
      const row = await this.operable(actor, connectionId);
      const oauth = await this.oauthService(taken.pending.network);
      const result = await oauth.completeAuthorization(taken.pending, query);
      await this.storeGrant(actor, row, result);
      return actor;
    } catch (err) {
      const failure = callbackFailure(err, connectionId);
      if (actor) await this.auditFailure(actor, connectionId, failure.reason);
      throw failure;
    }
  }

  private async storeGrant(actor: ActorContext, row: ConnectionRow, result: CompleteAuthorizationResult): Promise<void> {
    const usedBy = `mcp:${row.name}`;
    const token = await this.ctx.secrets.put({ name: `mcp ${row.name} oauth tokens`, kind: 'OAUTH_TOKENS', value: serializeOAuthTokenState(result.tokenState), usedBy });
    const client = await this.ctx.secrets.put({
      name: `mcp ${row.name} oauth client`,
      kind: 'OAUTH_CLIENT',
      value: serializeClientInformation(result.clientInformation),
      usedBy,
    });
    const info = result.clientInformation;
    await this.swapCredentials(actor, row, [token.ref, client.ref], {
      values: {
        authStrategy: 'OAUTH',
        authConfig: { issuer: result.issuer, clientId: info.clientId, registration: info.registration, resource: result.resource },
        tokenRef: token.ref,
        clientInfoRef: client.ref,
        grantedScopes: result.scopes,
      },
      action: 'mcp.connection.oauth_complete',
      summary: `Authorized ${row.name} with ${result.issuer}`,
      after: { issuer: result.issuer, clientId: info.clientId, registration: info.registration, scopes: result.scopes, credentialRef: token.ref, clientInfoRef: client.ref },
      guard: isPersonal(row) ? undefined : (tx, current) => assertOAuthAllowed(tx, current, { issuer: result.issuer, clientId: info.clientId, scopes: result.scopes }),
    });
  }

  /** Point the connection at new secret refs, then revoke the old ones (or the new ones if the write failed). */
  private async swapCredentials(
    actor: ActorContext,
    row: ConnectionRow,
    newRefs: string[],
    change: {
      values: Partial<typeof mcpConnections.$inferInsert>;
      action: string;
      summary: string;
      after: Record<string, unknown>;
      /** Maker–checker for a shared connection or template, inside the transaction (before the row lock, the order activation takes). */
      guard?: ((tx: DbOrTx, current: ConnectionRow) => Promise<void>) | undefined;
    },
  ): Promise<void> {
    let replaced: Array<string | null> = [];
    try {
      await this.ctx.db.transaction(async (tx) => {
        if (change.guard) await lockPlatformObject(tx, 'mcp_connection', row.id);
        const current = await loadConnection(tx, row.id, { lock: true });
        if (change.guard) await change.guard(tx, current);
        replaced = [current.tokenRef, current.clientInfoRef];
        if (current.status === 'DISABLED') throw connectionDisabled(row.id);
        await tx
          .update(mcpConnections)
          .set({ ...change.values, lastError: null, updatedAt: this.ctx.now() })
          .where(eq(mcpConnections.id, row.id));
        await recordAudit(tx, actor, {
          action: change.action,
          targetType: 'mcp_connection',
          targetId: row.id,
          summary: change.summary,
          before: { strategy: current.authStrategy, credentialRef: current.tokenRef, clientInfoRef: current.clientInfoRef },
          after: change.after,
        });
        await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: row.id });
      });
    } catch (err) {
      await revokeSecrets(this.ctx.secrets, newRefs);
      throw err;
    }
    // Revoke what the locked row actually pointed at (a concurrent change may have replaced `row`'s refs).
    await revokeSecrets(
      this.ctx.secrets,
      replaced.filter((r) => r && !newRefs.includes(r)),
    );
  }

  private async operable(actor: ActorContext, id: string): Promise<ConnectionRow> {
    const row = await loadConnection(this.ctx.db, id);
    assertCanOperate(actor, row);
    if (row.status === 'DISABLED') throw connectionDisabled(id);
    return row;
  }

  private async oauthService(network: ConnectionRow['network']): Promise<McpOAuthService> {
    const egress = await loadEgressPolicy(this.ctx.db, network);
    return new McpOAuthService({
      egress,
      resolver: this.ctx.resolver,
      limits: this.ctx.limits,
      pendingTtlMs: this.ctx.oauthPendingTtlMs,
      now: () => this.ctx.now().getTime(),
    });
  }

  /** Earlier client registration for re-authorization (the OAuth service reuses it only for the same issuer). */
  private async existingClient(row: ConnectionRow): Promise<McpOAuthClientInformation | undefined> {
    if (row.authStrategy !== 'OAUTH' || !row.clientInfoRef) return undefined;
    try {
      return parseClientInformation(await this.ctx.secrets.resolve(row.clientInfoRef));
    } catch {
      return undefined;
    }
  }

  /** The user who started the flow, re-checked now: they must still be active (RBAC is re-applied by `operable`). */
  private async actorFor(userId: string, correlationId: string): Promise<ActorContext> {
    // Effective permissions and teams as of now: a revoke since the flow started applies to its callback.
    const principal = await loadPrincipal(this.ctx.db, userId, 'UI');
    if (!principal) throw forbidden('mcp.oauth', 'the user who started this authorization is no longer active');
    return { principal, correlationId };
  }

  private async auditFailure(actor: ActorContext, connectionId: string, reason: string): Promise<void> {
    await this.ctx.db
      .transaction(async (tx) => {
        await recordAudit(tx, actor, {
          action: 'mcp.connection.oauth_failed',
          targetType: 'mcp_connection',
          targetId: connectionId,
          summary: `OAuth authorization failed (${reason})`,
          after: { reason },
        });
      })
      .catch(() => undefined);
  }
}

/**
 * OAuth on a shared connection or template (maker–checker, PM/research/11 §4). A draft authenticates freely
 * while no proposal locks it. A governed (approved or live) one may only be re-authorized: the same OAuth
 * server and client, scopes within those already granted — a token refresh by another name. Switching from a
 * header credential, to another server or client, or widening the scopes changes what the connection may do
 * and is an UPDATE proposal (409 approval_required). `grant` is null when the flow only begins.
 */
export async function assertOAuthAllowed(tx: DbOrTx, current: ConnectionRow, grant: { issuer: string; clientId: string; scopes: readonly string[] } | null): Promise<void> {
  await lockPlatformObject(tx, 'mcp_connection', current.id);
  await assertUnlocked(tx, { kind: 'mcp_connection' }, current.id);
  if (!(await platformGoverned(tx, 'mcp_connection', current.id))) return;
  const config = current.authConfig as { issuer?: string; clientId?: string };
  const refresh =
    current.authStrategy === 'OAUTH' &&
    (!grant || (grant.issuer === config.issuer && grant.clientId === config.clientId && grant.scopes.every((s) => current.grantedScopes.includes(s))));
  if (!refresh) throw approvalRequiredError('mcp_connection', current.id, 'UPDATE');
}
