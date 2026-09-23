import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { agentToolGrants, mcpConnections, tools } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanAdminister, assertCanDelete } from './access.js';
import type { OAuthPendingStore } from './pending-store.js';
import { affectedAgentIds, bumpAgents, isTemplate, loadConnection, revokeSecrets, type McpContext } from './records.js';
import { viewOf, type ConnectionView } from './views.js';

/** Wizard step (f): disable / enable / delete. Deleting revokes every secret the connection referenced. */
export class ConnectionAdmin {
  constructor(
    private readonly ctx: McpContext,
    private readonly pending: OAuthPendingStore,
  ) {}

  disable(actor: ActorContext, id: string): Promise<ConnectionView> {
    return this.setEnabled(actor, id, false);
  }

  enable(actor: ActorContext, id: string): Promise<ConnectionView> {
    return this.setEnabled(actor, id, true);
  }

  private async setEnabled(actor: ActorContext, id: string, enabled: boolean): Promise<ConnectionView> {
    const now = this.ctx.now();
    return this.ctx.db.transaction(async (tx) => {
      const conn = await loadConnection(tx, id, { lock: true });
      assertCanAdminister(actor, conn);
      const status = enabled ? (conn.status !== 'DISABLED' ? conn.status : conn.approvedAt ? 'ACTIVE' : 'PENDING') : 'DISABLED';
      if (status === conn.status) return viewOf(tx, conn);
      const [updated] = await tx
        .update(mcpConnections)
        // Re-enabled connections are health-checked on the next scheduler tick.
        .set({ status, updatedAt: now, ...(enabled ? { lastHealthAt: null } : {}) })
        .where(eq(mcpConnections.id, id))
        .returning();
      await recordAudit(tx, actor, {
        action: enabled ? 'mcp.connection.enable' : 'mcp.connection.disable',
        targetType: 'mcp_connection',
        targetId: id,
        summary: `${enabled ? 'Enabled' : 'Disabled'} ${conn.name}`,
        before: { status: conn.status },
        after: { status },
      });
      await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [id], conn.allowedAgentIds));
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
      return viewOf(tx, updated!);
    });
  }

  /** Deleting a template also deletes every personal instance derived from it. */
  async delete(actor: ActorContext, id: string): Promise<void> {
    const conn = await loadConnection(this.ctx.db, id);
    assertCanDelete(actor, conn);
    const instances = isTemplate(conn)
      ? await this.ctx.db
          .select()
          .from(mcpConnections)
          .where(and(eq(mcpConnections.templateId, id), isNotNull(mcpConnections.ownerUserId)))
      : [];
    const all = [conn, ...instances];
    const ids = all.map((c) => c.id);
    const refs = [...all.flatMap((c) => [c.tokenRef, c.clientInfoRef]), ...(await this.pending.refsFor(ids))].filter((r): r is string => !!r);

    await this.ctx.db.transaction(async (tx) => {
      const agents = await affectedAgentIds(tx, ids, conn.allowedAgentIds);
      const toolIds = (await tx.select({ id: tools.id }).from(tools).where(inArray(tools.connectionId, ids))).map((t) => t.id);
      // Grants reference tools without a foreign key; drop them with the tools (tools/pending/samples cascade).
      if (toolIds.length) await tx.delete(agentToolGrants).where(inArray(agentToolGrants.toolId, toolIds));
      await tx.delete(mcpConnections).where(inArray(mcpConnections.id, ids));
      await recordAudit(tx, actor, {
        action: 'mcp.connection.delete',
        targetType: 'mcp_connection',
        targetId: id,
        summary: `Deleted ${conn.name}${instances.length ? ` and ${instances.length} personal connections` : ''}; revoked ${refs.length} secrets`,
        before: { name: conn.name, url: conn.url, scope: conn.scope, status: conn.status, allowedAgentIds: conn.allowedAgentIds },
        after: { revokedCredentialRefs: refs, deletedConnectionIds: ids },
      });
      await bumpAgents(tx, actor.correlationId, agents);
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: id });
    });
    await revokeSecrets(this.ctx.secrets, refs);
  }
}
