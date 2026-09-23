import { and, asc, eq, inArray } from 'drizzle-orm';
import { Permission, can } from '@ocso/auth';
import { DomainError, forbidden, notFound, validation } from '@ocso/domain';
import { agentToolGrants, mcpConnections, tools, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import type { ArgumentRule } from '@ocso/tools';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { emitEvent } from '../events/outbox.js';
import { assertAgentManageable, assertAgentReadable } from '../agents/access.js';
import { lockAgentConfig } from '../agents/approval-lock.js';
import { approvalRequiredError, assertUnlocked, requiresApproval } from '../approvals/guard.js';
import type { ActorContext } from '../shared/context.js';
import { TOOL_GRANT_KIND, agentToolGrantApproval } from './agent-tool-grant-approval.js';
import { assertGrantable, grantConfigs, grantDelta, grantable, type GrantConfig } from './agent-tool-grant-rules.js';
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

/** What a replace did: applied now, and the widening part that needs a checker (null when nothing widens or the agent is a draft). */
export interface ToolGrantChange {
  view: AgentToolsView;
  applied: { removed: string[]; narrowed: string[]; granted: string[] };
  proposed: GrantConfig[] | null;
}

/**
 * Per-agent tool grants (docs/08 §6 "agent allowed"): the Lead enables
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

  /**
   * Replace the agent's grant set (PM/research/11b). A draft agent's set is
   * written as a whole. Once the agent (or its set) has been approved, the change
   * is split: removals and narrowing (tool off, confirmation on, rules added)
   * apply at once — a stop, never locked by an open proposal — and whatever
   * widens access is returned as `proposed` for the caller to route to a checker.
   */
  async replace(actor: ActorContext, agentId: string, raw: SetAgentToolGrantsInput): Promise<ToolGrantChange> {
    requirePermission(actor, Permission.AGENT_TOOLS_MANAGE);
    await assertAgentManageable(this.db, actor.principal!, agentId);
    const input = SetAgentToolGrantsInput.parse(raw);
    const ids = input.grants.map((g) => g.toolId);
    if (new Set(ids).size !== ids.length) throw validation('duplicate_tool_grant', 'Each tool may be granted once');
    const next = grantConfigs(input.grants as GrantConfig[]);

    return this.db.transaction(async (tx) => {
      await this.assertAgent(tx, agentId);
      await lockAgentConfig(tx, agentId);
      const before = grantConfigs(await tx.select().from(agentToolGrants).where(eq(agentToolGrants.agentId, agentId)));
      const delta = grantDelta(before, next);
      const governed = await requiresApproval(tx, agentToolGrantApproval, agentId, 'UPDATE');
      if (!governed) {
        // A draft: inert, written whole. Still waits while the agent's own proposal (which shows its tools) is open.
        await assertUnlocked(tx, agentToolGrantApproval, agentId);
        await assertGrantable(tx, agentId, delta.widened);
        await this.write(tx, actor, agentId, before, next, delta.removed, [...delta.narrowed, ...delta.widened], `Set ${next.length} tool grants (${next.filter((g) => g.enabled).length} enabled)`);
        return { view: await this.view(tx, agentId), applied: { removed: delta.removed, narrowed: delta.narrowed.map((g) => g.toolId), granted: delta.widened.map((g) => g.toolId) }, proposed: null };
      }
      // Governed: the stop half applies now; the widening half is for a checker.
      if (delta.widened.length) await assertGrantable(tx, agentId, delta.widened);
      if (delta.removed.length || delta.narrowed.length) {
        const kept = before.filter((g) => !delta.removed.includes(g.toolId)).map((g) => delta.narrowed.find((n) => n.toolId === g.toolId) ?? g);
        await this.write(tx, actor, agentId, before, kept, delta.removed, delta.narrowed, `Removed ${delta.removed.length} and narrowed ${delta.narrowed.length} tool grant(s)`);
        // Revocations of an approved set are told apart in the audit and the exception report (11b): one row each.
        for (const toolId of delta.removed) {
          await recordAudit(tx, actor, { action: 'agent_tool_grant.revoke', targetType: TOOL_GRANT_KIND, targetId: agentId, summary: `Revoked tool grant ${toolId} (immediate)`, before: before.find((g) => g.toolId === toolId) ?? null, after: { toolId, granted: false } });
        }
        for (const g of delta.narrowed) {
          await recordAudit(tx, actor, { action: 'agent_tool_grant.narrow', targetType: TOOL_GRANT_KIND, targetId: agentId, summary: `Narrowed tool grant ${g.toolId} (immediate)`, before: before.find((b) => b.toolId === g.toolId) ?? null, after: g });
        }
      }
      return {
        view: await this.view(tx, agentId),
        applied: { removed: delta.removed, narrowed: delta.narrowed.map((g) => g.toolId), granted: [] },
        proposed: delta.widened.length ? delta.widened : null,
      };
    });
  }

  /** replace() for callers that cannot route a proposal: 409 approval_required when part of the change widens access. */
  async set(actor: ActorContext, agentId: string, raw: SetAgentToolGrantsInput): Promise<AgentToolsView> {
    const change = await this.replace(actor, agentId, raw);
    if (change.proposed) throw withAppliedGrants(approvalRequiredError(TOOL_GRANT_KIND, agentId, 'UPDATE'), change.applied);
    return change.view;
  }

  private async write(tx: DbOrTx, actor: ActorContext, agentId: string, before: GrantConfig[], after: GrantConfig[], removed: string[], upserts: GrantConfig[], summary: string): Promise<void> {
    if (removed.length) await tx.delete(agentToolGrants).where(and(eq(agentToolGrants.agentId, agentId), inArray(agentToolGrants.toolId, removed)));
    for (const g of upserts) {
      const values = { enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules, updatedAt: new Date() };
      await tx.insert(agentToolGrants).values({ agentId, toolId: g.toolId, ...values }).onConflictDoUpdate({ target: [agentToolGrants.agentId, agentToolGrants.toolId], set: values });
    }
    await recordAudit(tx, actor, { action: 'agent.tools_update', targetType: 'agent', targetId: agentId, summary, before, after });
    await bumpGeneration(tx, actor.correlationId, `agent:${agentId}`, 'tools_changed');
    await emitEvent(tx, actor, 'config.changed', { area: 'agent_tools', entityId: agentId }, { agentId });
  }

  private async assertAgent(db: DbOrTx, agentId: string): Promise<void> {
    const [agent] = await db.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
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

/** Say in a 409 which removals and narrowing already applied (the widening part waits for a checker). */
export function withAppliedGrants(err: DomainError, applied: ToolGrantChange['applied']): DomainError {
  if (!applied.removed.length && !applied.narrowed.length) return err;
  return new DomainError(err.category, err.code, `${err.message} The removals and narrowing in this change were applied; the rest was not.`, { ...err.details, applied });
}
