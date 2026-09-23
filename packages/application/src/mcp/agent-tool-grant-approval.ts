import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { describeDiff, diffFields } from '@ocso/domain';
import { agentToolGrants, approvalProposals, mcpConnections, tools, virtualAgents, type DbOrTx } from '@ocso/db';
import type { ArgumentRule } from '@ocso/tools';
import { assertAgentManageable, assertAgentReadable, owningTeams } from '../agents/access.js';
import { lockAgentConfig } from '../agents/approval-lock.js';
import type { ApprovalDescriptor, ApprovalProblem, ProposalRow } from '../approvals/contract.js';
import { isApproved } from '../approvals/guard.js';
import { dependencyOf } from '../approvals/hashing.js';
import { recordAudit } from '../audit/audit.js';
import { bumpGeneration } from '../cache/generations.js';
import { isDomainError } from '@ocso/domain';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { AgentToolGrantAdditions, assertGrantable, grantConfigs, type GrantConfig } from './agent-tool-grant-rules.js';

/**
 * `agent_tool_grant` (PM/research/11 §4, 11b), checked with
 * approvals.check.agents. The object is one agent's grant set (object id = the
 * agent's id). A draft agent's grants are written directly — the agent's
 * go-live approval shows them. Once the agent (or its grant set) has been
 * approved, anything that widens what the agent may call is an UPDATE proposal
 * carrying only the widening grants; removals and narrowing apply at once
 * (AgentToolGrantService.replace splits the change).
 */
export const TOOL_GRANT_KIND = 'agent_tool_grant';

async function currentGrants(tx: DbOrTx, agentId: string): Promise<GrantConfig[]> {
  return grantConfigs(await tx.select().from(agentToolGrants).where(eq(agentToolGrants.agentId, agentId)));
}

function merged(current: readonly GrantConfig[], p: ProposalRow): GrantConfig[] {
  const additions = AgentToolGrantAdditions.parse(p.payload).grants as GrantConfig[];
  const byTool = new Map(current.map((g) => [g.toolId, g]));
  for (const g of additions) byTool.set(g.toolId, g);
  return grantConfigs([...byTool.values()]);
}

const describeRule = (r: ArgumentRule) => `${r.path} ${r.op}${r.value === undefined ? '' : ` ${JSON.stringify(r.value)}`} → ${r.effect === 'DENY' ? 'deny' : 'confirm'}: ${r.message}`;

/** Checker-readable: one entry per tool (connection · tool), with its switches and argument rules spelled out. */
async function projectGrants(tx: DbOrTx, agentId: string, grants: readonly GrantConfig[]): Promise<Record<string, unknown> | null> {
  const [agent] = await tx.select({ name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
  if (!agent) return null;
  const ids = grants.map((g) => g.toolId);
  const names = ids.length
    ? await tx.select({ id: tools.id, name: tools.name, connection: mcpConnections.name, risk: tools.riskClass }).from(tools).innerJoin(mcpConnections, eq(mcpConnections.id, tools.connectionId)).where(inArray(tools.id, ids)).orderBy(asc(tools.name))
    : [];
  const label = new Map(names.map((n) => [n.id, { label: `${n.connection} · ${n.name}`, risk: n.risk }]));
  const out: Record<string, unknown> = {};
  for (const g of grants) {
    const tool = label.get(g.toolId);
    out[tool?.label ?? `missing tool ${g.toolId.slice(0, 8)}`] = {
      enabled: g.enabled,
      alwaysConfirm: g.alwaysConfirm,
      risk: tool?.risk ?? null,
      argumentRules: g.argumentRules.map(describeRule),
    };
  }
  return { agent: agent.name, tools: out };
}

export const agentToolGrantApproval: ApprovalDescriptor = {
  kind: TOOL_GRANT_KIND,
  label: 'Agent tool grants',
  actions: ['UPDATE'],
  makePermission: () => Permission.AGENT_TOOLS_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_AGENTS,
  payload: AgentToolGrantAdditions,

  /** A draft agent's grants are part of its draft (its go-live shows them); once it (or the set) was approved, widening is a proposal. */
  async requiresApproval(tx, agentId) {
    return (await isApproved(tx, 'agent', agentId)) || isApproved(tx, TOOL_GRANT_KIND, agentId);
  },
  async project(tx, agentId) {
    return projectGrants(tx, agentId, await currentGrants(tx, agentId));
  },
  async projectAfter(tx, p) {
    return projectGrants(tx, p.objectId, merged(await currentGrants(tx, p.objectId), p));
  },
  /** Tool ids and the exact grant configuration (not names): what the agent may call is what the checker saw. */
  async hashBasis(tx, agentId) {
    const [agent] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
    return agent ? { agentId, grants: await currentGrants(tx, agentId) } : null;
  },
  lock: lockAgentConfig,
  /** The agent's own proposal shows its tools (a go-live): while it is open, grant proposals wait. */
  related: async (_tx, agentId) => [{ kind: 'agent', objectIds: [agentId] }],
  async teamIds(tx, agentId) {
    return ((await owningTeams(tx, [agentId])).get(agentId) ?? []).map((t) => t.id);
  },
  /** A tool re-classified (risk, approval) or removed after submit voids the proposal. */
  async dependencies(tx, p) {
    const ids = AgentToolGrantAdditions.safeParse(p.payload).data?.grants.map((g) => g.toolId) ?? [];
    if (!ids.length) return [];
    const rows = await tx.select({ id: tools.id, updatedAt: tools.updatedAt }).from(tools).where(inArray(tools.id, ids));
    return ids.map((id) => dependencyOf('tool', id, rows.find((r) => r.id === id)?.updatedAt));
  },
  assertVisible: (tx, principal, agentId) => assertAgentReadable(tx, principal, agentId),
  assertMakeable: (tx, principal, agentId) => assertAgentManageable(tx, principal, agentId),
  async validate(tx, p) {
    const [agent] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, p.objectId));
    if (!agent) return [{ code: 'object_missing', message: 'The agent no longer exists.' }];
    const additions = AgentToolGrantAdditions.safeParse(p.payload);
    if (!additions.success) return [{ code: 'invalid_payload', message: 'The proposed grants are not valid.' }];
    try {
      await assertGrantable(tx, p.objectId, additions.data.grants as GrantConfig[]);
      return [];
    } catch (err) {
      if (isDomainError(err)) return [{ code: err.code, message: err.message }] satisfies ApprovalProblem[];
      throw err;
    }
  },
  async activate(tx, actor, p) {
    const additions = AgentToolGrantAdditions.parse(p.payload).grants as GrantConfig[];
    const before = await currentGrants(tx, p.objectId);
    const now = new Date();
    for (const g of additions) {
      const values = { enabled: g.enabled, alwaysConfirm: g.alwaysConfirm, argumentRules: g.argumentRules, updatedAt: now };
      await tx.insert(agentToolGrants).values({ agentId: p.objectId, toolId: g.toolId, ...values }).onConflictDoUpdate({ target: [agentToolGrants.agentId, agentToolGrants.toolId], set: values });
    }
    await recordAudit(tx, actor, {
      action: 'agent.tools_update',
      targetType: 'agent',
      targetId: p.objectId,
      summary: `Granted or widened ${additions.length} tool(s) (approved)`,
      before,
      after: { granted: additions, proposalId: p.id },
    });
    await bumpGeneration(tx, actor.correlationId, `agent:${p.objectId}`, 'tools_changed');
    await emitEvent(tx, actor, 'config.changed', { area: 'agent_tools', entityId: p.objectId }, { agentId: p.objectId });
    return { kind: 'DONE' };
  },
  /**
   * Grant sets in effect (a live or paused agent with grants) that no approval covers: neither the agent's own
   * approval (its go-live showed the grants, and afterwards every widening is an agent_tool_grant proposal) nor
   * an approved grant proposal. Empty on a correctly governed (or grandfathered) deployment.
   */
  async liveObjects(tx) {
    const approvedAs = (kind: string) =>
      notExists(
        tx
          .select({ one: sql`1` })
          .from(approvalProposals)
          .where(and(eq(approvalProposals.objectKind, kind), eq(approvalProposals.objectId, virtualAgents.id), eq(approvalProposals.status, 'APPROVED'))),
      );
    const rows = await tx
      .selectDistinct({ id: virtualAgents.id })
      .from(virtualAgents)
      .innerJoin(agentToolGrants, eq(agentToolGrants.agentId, virtualAgents.id))
      .where(and(inArray(virtualAgents.status, ['LIVE', 'PAUSED']), approvedAs('agent'), approvedAs(TOOL_GRANT_KIND)));
    return rows.map((r) => r.id);
  },
  title(p, before) {
    return `Change ${String(before?.['agent'] ?? 'agent')}'s tools: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
