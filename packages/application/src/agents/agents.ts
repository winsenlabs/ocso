import { asc, eq } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { conflict, notFound } from '@ocso/domain';
import { agentTeams, promptVersions, virtualAgents, uuidv7, type Db } from '@ocso/db';
import { assertChangeAllowed } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { assertAgentManageable, assertAgentReadable, owningTeams, readableAgentFilter } from './access.js';
import { applyAgentStatus, applyAgentUpdate, lockAgent, rejectChannelIds } from './agent-writes.js';
import { reachForAgents } from '../routing/reach.js';
import { agentApproval } from './approval.js';
import { assertAgentUnlocked } from './approval-lock.js';
import type { AgentInput, AgentPatch, AgentRow, AgentView } from './inputs.js';
import { assertNewOwners, ownerAuthority, replaceOwners } from './owners.js';
import { initialComponents } from './prompt-templates.js';
import { createPromptVersion } from './prompt-versions.js';

export { AgentInput, AgentPatch, type AgentRow, type AgentView } from './inputs.js';

/**
 * Named virtual agents (docs/archive/specs/01 §4). A logical entity — never bound to a worker.
 * Reads and writes are scoped by owning team (agents/access.ts, ADR-026).
 */
export class AgentService {
  constructor(private readonly db: Db) {}

  /** Agents the principal may read (their teams' agents; every agent with agents.read_all). */
  async list(principal: Principal): Promise<AgentView[]> {
    assertCan(principal, Permission.AGENTS_READ);
    const rows = await this.db.select().from(virtualAgents).where(readableAgentFilter(principal, virtualAgents.id)).orderBy(asc(virtualAgents.name));
    const owners = await owningTeams(this.db, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, teams: owners.get(r.id) ?? [] }));
  }

  /** One readable agent; 404 when it does not exist or belongs to other teams only. */
  async get(principal: Principal, id: string): Promise<AgentView & { channelIds: string[] }> {
    assertCan(principal, Permission.AGENTS_READ);
    await assertAgentReadable(this.db, principal, id);
    return this.load(id);
  }

  private async load(id: string): Promise<AgentView & { channelIds: string[] }> {
    const [row] = await this.db.select().from(virtualAgents).where(eq(virtualAgents.id, id));
    if (!row) throw notFound('agent', id);
    // The channels that reach this agent through their routers and its queues ("Reached through").
    const [reach, owners] = await Promise.all([reachForAgents(this.db, [id]), owningTeams(this.db, [id])]);
    return { ...row, teams: owners.get(id) ?? [], channelIds: [...new Set(reach.map((c) => c.channelId))] };
  }

  /** Create an agent owned by `input.teamIds` (at least one; teams the creating lead belongs to). */
  async create(actor: ActorContext, input: AgentInput): Promise<AgentView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.AGENTS_MANAGE);
    const owners = assertNewOwners(principal, input.teamIds);
    rejectChannelIds(input.channelIds);
    const id = uuidv7();
    const slug = input.slug ?? slugify(input.name, id);
    return this.db.transaction(async (tx) => {
      const [clash] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.slug, slug));
      if (clash) throw conflict('agent_slug_taken', `An agent with slug ${slug} already exists`);
      const [agent] = await tx
        .insert(virtualAgents)
        .values({
          id,
          name: input.name,
          slug,
          purpose: input.purpose,
          conversationType: input.conversationType,
          description: input.description,
          modelProfileId: input.modelProfileId ?? null,
          summarizerProfileId: input.summarizerProfileId ?? null,
          copilotProfileId: input.copilotProfileId ?? null,
          defaultQueueId: input.defaultQueueId ?? null,
          ...(input.multimodal ? { multimodal: input.multimodal } : {}),
          ...(input.midTurnPolicy ? { midTurnPolicy: input.midTurnPolicy } : {}),
          ...(input.maxToolSteps ? { maxToolSteps: input.maxToolSteps } : {}),
          ...(input.businessHours ? { businessHours: input.businessHours } : {}),
          createdBy: actor.principal!.userId,
        })
        .returning();
      await tx.insert(agentTeams).values(owners.map((teamId) => ({ agentId: id, teamId })));
      const version = await createPromptVersion(tx, actor, {
        agentId: id,
        components: initialComponents(input.name, input.purpose, input.conversationType),
        reason: 'Initial version',
        parentVersionId: null,
      });
      await tx.update(virtualAgents).set({ activePromptVersionId: version.id }).where(eq(virtualAgents.id, id));
      await tx.update(promptVersions).set({ firstActivatedAt: new Date() }).where(eq(promptVersions.id, version.id));
      await recordAudit(tx, actor, { action: 'agent.create', targetType: 'agent', targetId: id, summary: `Created virtual agent ${input.name}`, after: { ...input, teamIds: owners } });
      await emitEvent(tx, actor, 'config.changed', { area: 'agent', entityId: id }, { agentId: id });
      const teams = (await owningTeams(tx, [id])).get(id) ?? [];
      return { ...agent!, activePromptVersionId: version.id, teams };
    });
  }

  /**
   * Change an agent. A draft (never approved) changes directly; once the agent
   * has been approved every change is a proposal (409 approval_required here;
   * the controller submits it), and an open proposal locks it (409 approval_open).
   */
  async update(actor: ActorContext, id: string, patch: AgentPatch): Promise<AgentView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.AGENTS_MANAGE);
    await assertAgentManageable(this.db, principal, id);
    return this.db.transaction(async (tx) => {
      await lockAgent(tx, id);
      await assertChangeAllowed(tx, agentApproval, id, 'UPDATE');
      return applyAgentUpdate(tx, actor, id, patch);
    });
  }

  /**
   * Replace the owning teams (PUT /v1/agents/:id/owners). A Tech admin
   * (agents.assign_owner) may assign any teams; a Lead only within their own
   * teams (owners.ts). Audited as agent.owners_change.
   */
  async setOwners(actor: ActorContext, id: string, teamIds: readonly string[]): Promise<AgentView & { channelIds: string[] }> {
    const principal = actor.principal!;
    const authority = ownerAuthority(principal);
    if (authority === 'ASSIGN_ANY') await assertAgentReadable(this.db, principal, id);
    else await assertAgentManageable(this.db, principal, id);
    await this.db.transaction(async (tx) => {
      const [agent] = await tx.select({ id: virtualAgents.id, name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, id)).for('update');
      if (!agent) throw notFound('agent', id);
      // Owners decide who may check the agent's proposals: never while one is open (it would change who checks it).
      await assertAgentUnlocked(tx, id);
      await replaceOwners(tx, actor, agent, teamIds, authority);
    });
    return this.load(id);
  }

  /**
   * Pause (agents.pause) is a stop action: immediate, never gated, allowed while
   * a proposal is open. Going live — first time or resuming — is an ACTIVATE and
   * always a proposal: this throws 409 approval_required (or approval_open).
   */
  async setStatus(actor: ActorContext, id: string, status: 'LIVE' | 'PAUSED'): Promise<AgentRow> {
    assertCan(actor.principal!, status === 'PAUSED' ? Permission.AGENTS_PAUSE : Permission.AGENTS_MANAGE);
    await assertAgentManageable(this.db, actor.principal!, id);
    return this.db.transaction(async (tx) => {
      await lockAgent(tx, id);
      if (status === 'LIVE') await assertChangeAllowed(tx, agentApproval, id, 'ACTIVATE');
      return applyAgentStatus(tx, actor, id, status);
    });
  }
}

function slugify(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || 'agent'}-${id.slice(-4)}`;
}

export { describeHours } from './agent-writes.js';
