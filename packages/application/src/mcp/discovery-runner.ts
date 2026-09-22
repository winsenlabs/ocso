import { eq } from 'drizzle-orm';
import { isDomainError } from '@ocso/domain';
import { mcpConnections } from '@ocso/db';
import { McpAuthRequiredError, McpConnectionError, McpDiscoveryService, type McpAuthRequired, type McpDiscoveryResult } from '@ocso/mcp';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanOperate } from './access.js';
import { SecretCredentialPort } from './credentials.js';
import { loadEgressPolicy } from './egress.js';
import { connectionDisabled } from './errors.js';
import {
  USABLE_STATUSES,
  affectedAgentIds,
  bumpAgents,
  connectionTarget,
  isPersonal,
  loadConnection,
  type ConnectionRow,
  type ConnectionStatus,
  type McpContext,
} from './records.js';
import { loadTemplateTools } from './template-mirror.js';
import { syncDiscoveredTools, type ToolSyncSummary } from './tool-sync.js';
import { viewOf, type ConnectionView } from './views.js';

export type DiscoveryOutcome =
  | { outcome: 'DISCOVERED'; connection: ConnectionView; tools: ToolSyncSummary; warnings: string[] }
  | { outcome: 'AUTH_REQUIRED'; connection: ConnectionView; authRequired: McpAuthRequired };

/**
 * Wizard step 2 "Discover" (and re-discovery): talk to the server outside any
 * transaction, then persist server info and reconcile `tools` under a row
 * lock. An auth challenge is an expected outcome (status AUTH_REQUIRED, with
 * the RFC 9728 metadata kept so the UI can offer OAuth or a header token).
 */
export class ConnectionDiscovery {
  constructor(private readonly ctx: McpContext) {}

  async run(actor: ActorContext, connectionId: string, mode: 'discover' | 'rediscover' = 'discover'): Promise<DiscoveryOutcome> {
    const row = await loadConnection(this.ctx.db, connectionId);
    assertCanOperate(actor, row);
    if (row.status === 'DISABLED') throw connectionDisabled(row.id);

    const credentials = new SecretCredentialPort(this.ctx.db, this.ctx.secrets);
    const egress = await loadEgressPolicy(this.ctx.db, row.network);
    const service = new McpDiscoveryService({ credentials, egress, resolver: this.ctx.resolver, limits: this.ctx.limits });
    let result: McpDiscoveryResult;
    try {
      result = await service.discover(connectionTarget(row), { timeoutMs: this.ctx.discoveryTimeoutMs });
    } catch (err) {
      if (err instanceof McpAuthRequiredError) return this.authRequired(actor, row.id, err.authRequired);
      const safe = isDomainError(err) ? err : new McpConnectionError('protocol_error');
      await this.ctx.db.update(mcpConnections).set({ lastError: safe.message }).where(eq(mcpConnections.id, row.id));
      throw safe;
    }
    return this.persist(actor, row.id, result, mode);
  }

  private async persist(actor: ActorContext, id: string, result: McpDiscoveryResult, mode: 'discover' | 'rediscover'): Promise<DiscoveryOutcome> {
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (tx) => {
      const current = await loadConnection(tx, id, { lock: true });
      if (current.status === 'DISABLED') throw connectionDisabled(id);
      const template = isPersonal(current) && current.templateId ? await loadConnection(tx, current.templateId).catch(() => null) : null;
      const templateTools = template ? await loadTemplateTools(tx, template.id) : isPersonal(current) ? new Map() : null;
      const summary = await syncDiscoveredTools(tx, current, result.tools, now, templateTools);

      const personalLive = isPersonal(current) && template?.approvedAt != null && template.status !== 'DISABLED';
      const status = statusAfterDiscovery(current, personalLive);
      const [updated] = await tx
        .update(mcpConnections)
        .set({
          serverInfo: {
            name: result.serverName,
            version: result.serverVersion,
            protocolEra: result.protocolEra,
            capabilities: result.capabilities,
            instructions: result.instructions,
            toolSetHash: result.toolSetHash,
            latencyMs: result.latencyMs,
          },
          protocolVersion: result.protocolVersion,
          lastSyncAt: now,
          lastError: null,
          status,
          updatedAt: now,
          ...(personalLive && !current.approvedAt ? { approvedAt: now, approvedBy: current.ownerUserId } : {}),
        })
        .where(eq(mcpConnections.id, id))
        .returning();

      await recordAudit(tx, actor, {
        action: `mcp.connection.${mode}`,
        targetType: 'mcp_connection',
        targetId: id,
        summary: `Discovered ${summary.total} tools on ${current.name} (${summary.added} new, ${summary.changed} changed, ${summary.removed} removed)`,
        after: { protocolVersion: result.protocolVersion, toolSetHash: result.toolSetHash, status, ...summary },
      });
      if (summary.catalogChanged || usabilityChanged(current.status, status)) {
        await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [id], current.allowedAgentIds));
      }
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
      return { outcome: 'DISCOVERED' as const, connection: await viewOf(tx, updated!), tools: summary, warnings: result.warnings };
    });
  }

  private async authRequired(actor: ActorContext, id: string, authRequired: McpAuthRequired): Promise<DiscoveryOutcome> {
    return this.ctx.db.transaction(async (tx) => {
      const current = await loadConnection(tx, id, { lock: true });
      const [updated] = await tx
        .update(mcpConnections)
        .set({
          status: current.status === 'DISABLED' ? 'DISABLED' : 'AUTH_REQUIRED',
          serverInfo: { ...current.serverInfo, authRequired },
          lastError: `Server requires authentication (${authRequired.reason})`,
          updatedAt: this.ctx.now(),
        })
        .where(eq(mcpConnections.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: 'mcp.connection.auth_required',
        targetType: 'mcp_connection',
        targetId: id,
        summary: `${current.name} requires authentication (${authRequired.oauthAvailable ? 'OAuth available' : 'header token'})`,
        after: { reason: authRequired.reason, redirectFlowAvailable: authRequired.oauthAvailable, issuers: authRequired.authorizationServers },
      });
      if (usabilityChanged(current.status, updated!.status)) {
        await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [id], current.allowedAgentIds));
      }
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
      return { outcome: 'AUTH_REQUIRED' as const, connection: await viewOf(tx, updated!), authRequired };
    });
  }
}

/**
 * Unapproved connections stay PENDING (review/approve next); approved ones
 * recover to ACTIVE from PENDING/AUTH_REQUIRED/DOWN (health owns DEGRADED);
 * personal instances go live once their template is published.
 */
function statusAfterDiscovery(row: ConnectionRow, personalLive: boolean): ConnectionStatus {
  const approved = isPersonal(row) ? personalLive : row.approvedAt !== null;
  if (!approved) return 'PENDING';
  return row.status === 'DEGRADED' ? 'DEGRADED' : 'ACTIVE';
}

export function usabilityChanged(before: ConnectionStatus, after: ConnectionStatus): boolean {
  return USABLE_STATUSES.has(before) !== USABLE_STATUSES.has(after);
}
