import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { mcpConnections, tools, virtualAgents } from '@ocso/db';
import { validation } from '@ocso/domain';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertCanAdminister } from './access.js';
import { connectionAuthRequired, connectionDisabled, connectionNotDiscovered, noToolsApproved, unknownTools } from './errors.js';
import { ApproveConnectionInput, ClassifyToolsInput } from './inputs.js';
import { affectedAgentIds, bumpAgents, isTemplate, loadConnection, type McpContext } from './records.js';
import { propagateTemplateClassification } from './template-mirror.js';
import { toToolView, viewOf, type ConnectionView, type ToolView } from './views.js';

/**
 * Wizard steps 4 "Review capabilities" and 5 "Approve". The admin's
 * classification is authoritative; server annotations only seeded it.
 */
export class ConnectionReview {
  constructor(private readonly ctx: McpContext) {}

  async classifyTools(actor: ActorContext, connectionId: string, raw: ClassifyToolsInput): Promise<ToolView[]> {
    const input = ClassifyToolsInput.parse(raw);
    const now = this.ctx.now();
    const ids = input.tools.map((t) => t.toolId);
    if (new Set(ids).size !== ids.length) throw validation('mcp_duplicate_tools', 'Each tool may appear once');
    return this.ctx.db.transaction(async (tx) => {
      const conn = await loadConnection(tx, connectionId, { lock: true });
      assertCanAdminister(actor, conn);
      const rows = await tx
        .select()
        .from(tools)
        .where(and(eq(tools.connectionId, connectionId), inArray(tools.id, ids), isNull(tools.removedAt)));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length) throw unknownTools(missing);

      const before: unknown[] = [];
      const after: unknown[] = [];
      for (const item of input.tools) {
        const prev = byId.get(item.toolId)!;
        before.push({ toolId: prev.id, name: prev.name, riskClass: prev.riskClass, approved: prev.approved, humanRoles: prev.humanRoles });
        after.push({ toolId: prev.id, name: prev.name, riskClass: item.riskClass, approved: item.approved, humanRoles: item.humanRoles ?? prev.humanRoles });
        await tx
          .update(tools)
          .set({
            riskClass: item.riskClass,
            approved: item.approved,
            ...(item.humanRoles ? { humanRoles: [...item.humanRoles] } : {}),
            ...(item.approved ? { changedSinceApproval: false } : {}),
            updatedAt: now,
          })
          .where(eq(tools.id, prev.id));
      }
      // Touch the connection so runtime tool providers reload the approved definitions.
      await tx.update(mcpConnections).set({ updatedAt: now }).where(eq(mcpConnections.id, connectionId));
      if (isTemplate(conn)) await propagateTemplateClassification(tx, connectionId, now);

      const approvedCount = after.filter((a) => (a as { approved: boolean }).approved).length;
      await recordAudit(tx, actor, {
        action: 'mcp.tools.classify',
        targetType: 'mcp_connection',
        targetId: connectionId,
        summary: `Classified ${input.tools.length} tools on ${conn.name} (${approvedCount} approved)`,
        before,
        after,
      });
      await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [connectionId], conn.allowedAgentIds));
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: connectionId });
      const all = await tx.select().from(tools).where(eq(tools.connectionId, connectionId)).orderBy(asc(tools.name));
      return all.map(toToolView);
    });
  }

  async approve(actor: ActorContext, connectionId: string, raw: ApproveConnectionInput): Promise<ConnectionView> {
    const input = ApproveConnectionInput.parse(raw);
    const now = this.ctx.now();
    const allowed = input.allowedAgentIds === '*' ? ['*'] : [...new Set(input.allowedAgentIds)];
    return this.ctx.db.transaction(async (tx) => {
      const conn = await loadConnection(tx, connectionId, { lock: true });
      const principal = assertCanAdminister(actor, conn);
      if (conn.status === 'DISABLED') throw connectionDisabled(connectionId);
      if (conn.status === 'AUTH_REQUIRED' && !conn.approvedAt) throw connectionAuthRequired(connectionId);
      if (!conn.lastSyncAt) throw connectionNotDiscovered(connectionId);
      if (isTemplate(conn) && (allowed.length > 0 || input.sendCustomerClaims)) {
        throw validation('mcp_user_scope_agents', 'User-scoped connections are never available to virtual agents');
      }
      const explicit = allowed.filter((id) => id !== '*');
      if (explicit.length) {
        const found = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(inArray(virtualAgents.id, explicit));
        const unknown = explicit.filter((id) => !found.some((f) => f.id === id));
        if (unknown.length) throw validation('mcp_unknown_agents', 'Some agents do not exist', { agentIds: unknown });
      }
      const [approvedTool] = await tx
        .select({ id: tools.id })
        .from(tools)
        .where(and(eq(tools.connectionId, connectionId), eq(tools.approved, true), isNull(tools.removedAt)))
        .limit(1);
      if (!approvedTool) throw noToolsApproved();

      const [updated] = await tx
        .update(mcpConnections)
        .set({
          status: conn.status === 'PENDING' ? 'ACTIVE' : conn.status,
          allowedAgentIds: allowed,
          confirmationPolicy: input.confirmationPolicy,
          sendCustomerClaims: input.sendCustomerClaims,
          healthCheckSeconds: input.healthCheckSeconds,
          approvedBy: principal.userId,
          approvedAt: now,
          lastHealthAt: null, // health checks start right away
          updatedAt: now,
        })
        .where(eq(mcpConnections.id, connectionId))
        .returning();
      await recordAudit(tx, actor, {
        action: 'mcp.connection.approve',
        targetType: 'mcp_connection',
        targetId: connectionId,
        summary: `Approved ${conn.name} for ${input.allowedAgentIds === '*' ? 'any enabled agent' : `${explicit.length} agents`}`,
        before: policyOf(conn),
        after: policyOf(updated!),
      });
      await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [connectionId], [...conn.allowedAgentIds, ...allowed]));
      await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: connectionId });
      return viewOf(tx, updated!);
    });
  }
}

function policyOf(row: typeof mcpConnections.$inferSelect) {
  return {
    status: row.status,
    allowedAgentIds: row.allowedAgentIds,
    confirmationPolicy: row.confirmationPolicy,
    sendCustomerClaims: row.sendCustomerClaims,
    healthCheckSeconds: row.healthCheckSeconds,
  };
}
