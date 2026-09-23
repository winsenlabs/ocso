import { and, asc, eq, inArray, isNotNull, isNull, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { forbidden, notFound, validation } from '@ocso/domain';
import { agentToolGrants, mcpConnections, tools, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import type { ArgumentRule } from '@ocso/tools';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import { assertAgentManageable, assertAgentReadable } from '../agents/access.js';
import type { ActorContext } from '../shared/context.js';
import { requirePermission } from './access.js';
import { SetAgentToolGrantsInput } from './inputs.js';
import type { ConnectionRow, ToolRow } from './records.js';

export interface AgentToolEntry {
  toolId: string;
  connectionId: string;
  connectionName: string;
  connectionStatus: ConnectionRow['status'];
  name: string;
  title: string | null;
  modelName: string;
  description: string;
  riskClass: ToolRow['riskClass'];
  /** Tool input schema, so argument rules can offer valid paths. */
  inputSchema: Record<string, unknown>;
  /** False when a grant exists but the tool is no longer grantable (un-approved, removed, connection no longer allows the agent). */
  eligible: boolean;
  grant: { enabled: boolean; alwaysConfirm: boolean; argumentRules: ArgumentRule[] } | null;
}

export interface AgentToolsView {
  agentId: string;
  tools: AgentToolEntry[];
}

/** Tools an agent may be granted: approved, live, on an approved SHARED connection that allows this agent. */
function grantable(agentId: string): SQL {
  return and(
    eq(tools.approved, true),
    isNull(tools.removedAt),
    eq(mcpConnections.scope, 'SHARED'),
    isNull(mcpConnections.ownerUserId),
    isNotNull(mcpConnections.approvedAt),
    ne(mcpConnections.status, 'DISABLED'),
    sql`(${mcpConnections.allowedAgentIds} @> ARRAY['*']::text[] OR ${mcpConnections.allowedAgentIds} @> ARRAY[${agentId}]::text[])`,
  )!;
}

/**
 * Per-agent tool grants (docs/08 §6 "agent allowed"): the CS Lead enables
 * specific approved tools for a virtual agent, with deterministic argument
 * rules. Every change invalidates the agent's cached tool catalogue. Reads
 * need a readable agent, changes a lead of an owning team (ADR-026); 404
 * otherwise.
 */
export class AgentToolGrantService {
  constructor(private readonly db: Db) {}

  async list(actor: ActorContext, agentId: string): Promise<AgentToolsView> {
    const principal = actor.principal;
    if (!principal || !(can(principal, Permission.AGENTS_READ) || can(principal, Permission.AGENT_TOOLS_MANAGE))) {
      throw forbidden(Permission.AGENTS_READ, 'requires agents.read or agent_tools.manage');
    }
    await assertAgentReadable(this.db, principal, agentId);
    return this.view(this.db, agentId);
  }

  /** Replace the agent's grant set. Only grantable tools are accepted; argument rule paths must exist in the tool's input schema. */
  async set(actor: ActorContext, agentId: string, raw: SetAgentToolGrantsInput): Promise<AgentToolsView> {
    requirePermission(actor, Permission.AGENT_TOOLS_MANAGE);
    await assertAgentManageable(this.db, actor.principal!, agentId);
    const input = SetAgentToolGrantsInput.parse(raw);
    const ids = input.grants.map((g) => g.toolId);
    if (new Set(ids).size !== ids.length) throw validation('duplicate_tool_grant', 'Each tool may be granted once');

    return this.db.transaction(async (tx) => {
      await this.assertAgent(tx, agentId, true);
      const eligible = ids.length
        ? await tx
            .select({ t: tools })
            .from(tools)
            .innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId))
            .where(and(inArray(tools.id, ids), grantable(agentId)))
        : [];
      const byId = new Map(eligible.map((r) => [r.t.id, r.t]));
      const refused = ids.filter((id) => !byId.has(id));
      if (refused.length) throw validation('tool_not_grantable', 'Some tools are not approved for this agent', { toolIds: refused });
      for (const g of input.grants) assertRulePaths(byId.get(g.toolId)!, g.argumentRules);

      const before = await tx.select().from(agentToolGrants).where(eq(agentToolGrants.agentId, agentId));
      await tx
        .delete(agentToolGrants)
        .where(ids.length ? and(eq(agentToolGrants.agentId, agentId), notInArray(agentToolGrants.toolId, ids)) : eq(agentToolGrants.agentId, agentId));
      for (const g of input.grants) {
        const values = { enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules as ArgumentRule[], updatedAt: new Date() };
        await tx
          .insert(agentToolGrants)
          .values({ agentId, toolId: g.toolId, ...values })
          .onConflictDoUpdate({ target: [agentToolGrants.agentId, agentToolGrants.toolId], set: values });
      }
      await recordAudit(tx, actor, {
        action: 'agent.tools_update',
        targetType: 'agent',
        targetId: agentId,
        summary: `Set ${input.grants.length} tool grants (${input.grants.filter((g) => g.enabled).length} enabled)`,
        before: before.map(({ toolId, enabled, alwaysConfirm, argumentRules }) => ({ toolId, enabled, alwaysConfirm, argumentRules })),
        after: input.grants,
      });
      await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'tools_changed');
      await emitEvent(tx, actor, 'config.changed', { area: 'agent_tools', entityId: agentId }, { agentId });
      return this.view(tx, agentId);
    });
  }

  private async assertAgent(db: DbOrTx, agentId: string, lock = false): Promise<void> {
    const query = db.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
    const [agent] = lock ? await query.for('update') : await query;
    if (!agent) throw notFound('agent', agentId);
  }

  private async view(db: DbOrTx, agentId: string): Promise<AgentToolsView> {
    const available = await db
      .select({ t: tools, c: mcpConnections })
      .from(tools)
      .innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId))
      .where(grantable(agentId))
      .orderBy(asc(mcpConnections.name), asc(tools.name));
    const grants = await db.select().from(agentToolGrants).where(eq(agentToolGrants.agentId, agentId));
    const grantByTool = new Map(grants.map((g) => [g.toolId, g]));
    const entries = new Map<string, AgentToolEntry>();
    const add = (t: ToolRow, c: ConnectionRow, eligible: boolean) => {
      const g = grantByTool.get(t.id);
      entries.set(t.id, {
        toolId: t.id,
        connectionId: c.id,
        connectionName: c.name,
        connectionStatus: c.status,
        name: t.name,
        title: t.title,
        modelName: t.modelName,
        description: t.description,
        riskClass: t.riskClass,
        inputSchema: t.inputSchema,
        eligible,
        grant: g ? { enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules } : null,
      });
    };
    for (const { t, c } of available) add(t, c, true);
    const orphaned = grants.filter((g) => !entries.has(g.toolId)).map((g) => g.toolId);
    if (orphaned.length) {
      const rows = await db.select({ t: tools, c: mcpConnections }).from(tools).innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId)).where(inArray(tools.id, orphaned));
      for (const { t, c } of rows) add(t, c, false);
    }
    return { agentId, tools: [...entries.values()] };
  }
}

/** Rule paths must start at a declared argument when the tool's input schema declares properties. */
function assertRulePaths(tool: ToolRow, rules: readonly { path: string }[]): void {
  const props = tool.inputSchema['properties'];
  if (!props || typeof props !== 'object') return;
  const unknown = rules.map((r) => r.path).filter((p) => !Object.hasOwn(props, p.split('.')[0]!));
  if (unknown.length) throw validation('unknown_argument_path', `Argument rules reference unknown arguments of ${tool.name}`, { toolId: tool.id, paths: unknown });
}
