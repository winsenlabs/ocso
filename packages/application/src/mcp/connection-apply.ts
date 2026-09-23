import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { agentToolGrants, mcpConnections, mcpOauthPending, tools, virtualAgents, type DbOrTx } from '@ocso/db';
import { validation } from '@ocso/domain';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ApprovalProblem } from '../approvals/contract.js';
import type { ActorContext } from '../shared/context.js';
import { unknownTools } from './errors.js';
import { ApproveConnectionInput, ClassifyToolsInput } from './inputs.js';
import { affectedAgentIds, bumpAgents, isTemplate, type ConnectionRow } from './records.js';
import { propagateTemplateClassification } from './template-mirror.js';

/**
 * The writes behind an MCP connection's configuration, shared by the draft
 * (direct) path and approval activation (connection-approval.ts): the admin's
 * tool classification, the connection policy, going live, and deletion.
 */

export type ConnectionPolicy = z.output<typeof ApproveConnectionInput>;
export type ToolClassification = z.output<typeof ClassifyToolsInput>['tools'];

export const policyOf = (row: ConnectionRow) => ({
  status: row.status,
  allowedAgentIds: row.allowedAgentIds,
  confirmationPolicy: row.confirmationPolicy,
  sendCustomerClaims: row.sendCustomerClaims,
  forwardUserToken: row.forwardUserToken,
  healthCheckSeconds: row.healthCheckSeconds,
});

/** Why a policy cannot apply (agents that do not exist, agents on a user-scope template). */
export async function policyProblems(tx: DbOrTx, conn: ConnectionRow, policy: ConnectionPolicy): Promise<ApprovalProblem[]> {
  const allowed = policy.allowedAgentIds === '*' ? ['*'] : [...new Set(policy.allowedAgentIds)];
  if (isTemplate(conn) && (allowed.length > 0 || policy.sendCustomerClaims || policy.forwardUserToken)) {
    return [{ code: 'mcp_user_scope_agents', message: 'User-scoped connections are never available to virtual agents.' }];
  }
  const explicit = allowed.filter((id) => id !== '*');
  if (!explicit.length) return [];
  const found = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(inArray(virtualAgents.id, explicit));
  const unknown = explicit.filter((id) => !found.some((f) => f.id === id));
  return unknown.length ? [{ code: 'mcp_unknown_agents', message: `Some agents do not exist (${unknown.join(', ')}).` }] : [];
}

/** What going live needs: a successful discovery, authentication when asked for, and at least one approved tool. */
export async function readinessProblems(tx: DbOrTx, conn: ConnectionRow): Promise<ApprovalProblem[]> {
  const problems: ApprovalProblem[] = [];
  if (!conn.lastSyncAt) problems.push({ code: 'mcp_connection_not_discovered', message: 'Discover the server’s tools first.' });
  if (conn.status === 'AUTH_REQUIRED' && !conn.approvedAt) problems.push({ code: 'mcp_connection_auth_required', message: 'Authenticate the connection first.' });
  const [approvedTool] = await tx
    .select({ id: tools.id })
    .from(tools)
    .where(and(eq(tools.connectionId, conn.id), eq(tools.approved, true), isNull(tools.removedAt)))
    .limit(1);
  if (!approvedTool) problems.push({ code: 'mcp_no_tools_approved', message: 'Approve at least one tool before activating the connection.' });
  return problems;
}

/** Tool review (risk class, approved, human roles); the admin's classification is authoritative. */
export async function writeToolClassification(tx: DbOrTx, actor: ActorContext, conn: ConnectionRow, items: ToolClassification, now: Date): Promise<void> {
  const ids = items.map((t) => t.toolId);
  if (new Set(ids).size !== ids.length) throw validation('mcp_duplicate_tools', 'Each tool may appear once');
  const rows = await tx
    .select()
    .from(tools)
    .where(and(eq(tools.connectionId, conn.id), inArray(tools.id, ids), isNull(tools.removedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length) throw unknownTools(missing);
  const before: unknown[] = [];
  const after: unknown[] = [];
  for (const item of items) {
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
  await tx.update(mcpConnections).set({ updatedAt: now }).where(eq(mcpConnections.id, conn.id));
  if (isTemplate(conn)) await propagateTemplateClassification(tx, conn.id, now);
  const approvedCount = after.filter((a) => (a as { approved: boolean }).approved).length;
  await recordAudit(tx, actor, {
    action: 'mcp.tools.classify',
    targetType: 'mcp_connection',
    targetId: conn.id,
    summary: `Classified ${items.length} tools on ${conn.name} (${approvedCount} approved)`,
    before,
    after,
  });
  await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [conn.id], conn.allowedAgentIds));
  await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: conn.id });
}

/**
 * Write the connection policy. `live` also takes the connection live (the activation of an approval): status
 * ACTIVE (a disabled one is resumed), approved by the checker, health checks start right away.
 */
export async function writeConnectionPolicy(
  tx: DbOrTx,
  actor: ActorContext,
  conn: ConnectionRow,
  policy: ConnectionPolicy | null,
  o: { now: Date; live?: { approvedBy: string | null } | undefined },
): Promise<ConnectionRow> {
  const allowed = policy ? (policy.allowedAgentIds === '*' ? ['*'] : [...new Set(policy.allowedAgentIds)]) : conn.allowedAgentIds;
  const [updated] = await tx
    .update(mcpConnections)
    .set({
      ...(policy
        ? { allowedAgentIds: allowed, confirmationPolicy: policy.confirmationPolicy, sendCustomerClaims: policy.sendCustomerClaims, forwardUserToken: policy.forwardUserToken, healthCheckSeconds: policy.healthCheckSeconds }
        : {}),
      ...(o.live ? { status: 'ACTIVE' as const, approvedBy: o.live.approvedBy, approvedAt: o.now, lastHealthAt: null } : {}),
      updatedAt: o.now,
    })
    .where(eq(mcpConnections.id, conn.id))
    .returning();
  const resumed = o.live && conn.status === 'DISABLED';
  await recordAudit(tx, actor, {
    action: o.live ? (resumed ? 'mcp.connection.enable' : 'mcp.connection.approve') : 'mcp.connection.policy',
    redaction: 'settings',
    targetType: 'mcp_connection',
    targetId: conn.id,
    summary: o.live
      ? `${resumed ? 'Re-enabled' : 'Activated'} ${conn.name} for ${allowed.includes('*') ? 'any enabled agent' : `${allowed.length} agents`}`
      : `Set the agent policy of ${conn.name}`,
    before: policyOf(conn),
    after: policyOf(updated!),
  });
  await bumpAgents(tx, actor.correlationId, await affectedAgentIds(tx, [conn.id], [...conn.allowedAgentIds, ...allowed]));
  await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: conn.id });
  return updated!;
}

/** Delete a connection (a template takes its personal instances with it) and return the secrets to revoke after commit. */
export async function deleteConnectionRows(tx: DbOrTx, actor: ActorContext, conn: ConnectionRow): Promise<string[]> {
  const instances = isTemplate(conn)
    ? await tx
        .select()
        .from(mcpConnections)
        .where(and(eq(mcpConnections.templateId, conn.id), isNotNull(mcpConnections.ownerUserId)))
    : [];
  const all = [conn, ...instances];
  const ids = all.map((c) => c.id);
  const pending = await tx.select({ ref: mcpOauthPending.pendingRef }).from(mcpOauthPending).where(inArray(mcpOauthPending.connectionId, ids));
  const refs = [...all.flatMap((c) => [c.tokenRef, c.clientInfoRef]), ...pending.map((p) => p.ref)].filter((r): r is string => !!r);
  const agents = await affectedAgentIds(tx, ids, conn.allowedAgentIds);
  const toolIds = (await tx.select({ id: tools.id }).from(tools).where(inArray(tools.connectionId, ids)).orderBy(asc(tools.id))).map((t) => t.id);
  // Grants reference tools without a foreign key; drop them with the tools (tools/pending/samples cascade).
  if (toolIds.length) await tx.delete(agentToolGrants).where(inArray(agentToolGrants.toolId, toolIds));
  await tx.delete(mcpConnections).where(inArray(mcpConnections.id, ids));
  await recordAudit(tx, actor, {
    action: 'mcp.connection.delete',
    targetType: 'mcp_connection',
    targetId: conn.id,
    summary: `Deleted ${conn.name}${instances.length ? ` and ${instances.length} personal connections` : ''}; revoked ${refs.length} secrets`,
    before: { name: conn.name, url: conn.url, scope: conn.scope, status: conn.status, allowedAgentIds: conn.allowedAgentIds },
    after: { revokedCredentialRefs: refs, deletedConnectionIds: ids },
  });
  await bumpAgents(tx, actor.correlationId, agents);
  await emitEvent(tx, actor, 'config.changed', { area: 'mcp', entityId: conn.id });
  return refs;
}
