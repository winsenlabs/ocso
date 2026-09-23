import { asc, eq, inArray, sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { AttrKey, BusinessHoursSchema, conflict, notFound, validation } from '@ocso/domain';
import { conversations, queueTeams, queues, slaPolicies, teamMembers, users, uuidv7, virtualAgents, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { assertChangeAllowed, openProposals } from '../approvals/guard.js';
import { approvalGates } from './approval-checks.js';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { patchOf } from '../shared/patch.js';
import { queueApproval } from './queue-approval.js';
import { assertAgentAssignable, assertQueueInScope, assertTeamChange } from './queue-guards.js';
import { applyQueuePatch, applyQueueStops, isEmptyPatch, lockQueue, normalizeAttributes, type QueueApprovalPatch, type QueueStops } from './queue-writes.js';
import { SlaPolicyInput, applySlaPolicy, lockSlaPolicy, slaPolicyApproval } from './sla-approval.js';

export const QueueInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).default('OPEN_PICKUP'),
  autoAssignAfterSeconds: z.number().int().min(10).max(86_400).nullable().default(null),
  acceptTimeoutSeconds: z.number().int().min(15).max(3_600).default(120),
  requiredSkills: z.array(z.string().max(60)).max(20).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  preferAccountOwner: z.boolean().default(true),
  slaPolicyId: z.uuid().nullable().default(null),
  teamIds: z.array(z.uuid()).default([]),
  /** The queue's one AI agent (PM/research/11 §5.5); an agent may serve many queues. */
  agentId: z.uuid().nullable().default(null),
  /** What the queue serves, e.g. { language: 'ta', product: 'sales' } (unique across queues). */
  attributes: z.record(AttrKey, z.string().trim().min(1).max(60)).default({}),
  /** When humans take handoffs from this queue; null = the agent's hours. */
  businessHours: BusinessHoursSchema.nullable().default(null),
  /** Queues conversations may be transferred to from here. */
  transferTargetIds: z.array(z.uuid()).max(50).default([]),
});
export type QueueInput = z.infer<typeof QueueInput>;
export const QueuePatch = patchOf(QueueInput);
export type QueuePatch = z.infer<typeof QueuePatch>;
/**
 * The team and transfer-target lists the editor loaded. With it, a PATCH's full lists are read as edits of
 * that baseline: only ids the editor saw and unticked are removed, so a stale form never undoes a team or
 * target added (or approved) since it was opened. Without it, the lists replace the current ones.
 */
export const QueueBaseline = z.object({ teamIds: z.array(z.uuid()).max(50).optional(), transferTargetIds: z.array(z.uuid()).max(50).optional() });
export type QueueBaseline = z.infer<typeof QueueBaseline>;

export { SlaPolicyInput } from './sla-approval.js';

export interface QueueView extends Omit<typeof queues.$inferSelect, 'createdAt' | 'updatedAt'> {
  teamIds: string[];
  waiting: number;
  oldestWaitingSince: string | null;
  onShift: number;
  members: number;
  breaches: number;
  /** Maker–checker (wave 2): approved (routers may use it; changes are proposals), and the open proposal if any. */
  approval: ApprovalSummary;
}

export interface ApprovalSummary {
  approved: boolean;
  pending: { id: string; action: string; checkerName: string | null } | null;
}

/** Approval summaries for list screens: one query per kind, not per row. */
async function approvalSummaries(db: DbOrTx, kind: string, ids: readonly string[]): Promise<Map<string, ApprovalSummary>> {
  const [gates, open] = await Promise.all([approvalGates(db, kind, ids), openProposals(db, kind, ids)]);
  return new Map(ids.map((id) => {
    const p = open.get(id);
    return [id, { approved: gates.get(id) === 'approved', pending: p ? { id: p.id, action: p.action, checkerName: p.checkerName } : null }];
  }));
}

/** Queues, their teams and SLA policies (design/02 Routing tab, design/06 lead Queues table). */
export class QueueService {
  constructor(private readonly db: Db) {}

  async list(): Promise<QueueView[]> {
    const rows = await this.db.select().from(queues).orderBy(asc(queues.name));
    const links = await this.db.select().from(queueTeams);
    const stats = await this.db.execute<{ queue_id: string; waiting: number; oldest: Date | null; breaches: number }>(sql`
      SELECT queue_id, count(*) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN')::int AS waiting,
             min(waiting_since) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN') AS oldest,
             count(*) FILTER (WHERE control_state = 'WAITING_FOR_HUMAN' AND sla_due_at < now())::int AS breaches
        FROM ${conversations} WHERE queue_id IS NOT NULL GROUP BY queue_id`);
    const staff = await this.db
      .select({ teamId: teamMembers.teamId, availability: users.availability })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId));
    const approvals = await approvalSummaries(this.db, 'queue', rows.map((r) => r.id));
    return rows.map(({ createdAt: _c, updatedAt: _u, ...q }) => {
      const teamIds = links.filter((l) => l.queueId === q.id).map((l) => l.teamId);
      const people = staff.filter((s) => teamIds.includes(s.teamId));
      const s = stats.rows.find((r) => r.queue_id === q.id);
      return {
        ...q,
        teamIds,
        waiting: s?.waiting ?? 0,
        oldestWaitingSince: s?.oldest ? new Date(s.oldest).toISOString() : null,
        breaches: s?.breaches ?? 0,
        members: people.length,
        onShift: people.filter((p) => p.availability === 'AVAILABLE').length,
        approval: approvals.get(q.id) ?? { approved: false, pending: null },
      };
    });
  }

  async create(actor: ActorContext, input: QueueInput): Promise<string> {
    const principal = actor.principal!;
    assertCan(principal, Permission.QUEUES_MANAGE);
    const id = uuidv7();
    const { teamIds, ...fields } = input;
    await this.guarded(input.name, async (tx) => {
      if (fields.agentId) await assertAgentAssignable(tx, principal, fields.agentId);
      await assertQueueRefs(tx, id, fields);
      await tx.insert(queues).values({ id, ...fields, attributes: normalizeAttributes(fields.attributes) });
      if (teamIds.length) await tx.insert(queueTeams).values(teamIds.map((teamId) => ({ queueId: id, teamId })));
      await recordAudit(tx, actor, { action: 'queue.create', targetType: 'queue', targetId: id, summary: `Created queue ${input.name}`, after: input });
    });
    return id;
  }

  /**
   * What a PATCH does (PM/research/11 §5.5, wave 2), after the team-scope checks of the direct path: the stops
   * (unlinking your own teams, removing transfer targets — applied at once, never locked) and the approvable
   * change (everything else, a delta for teams and transfer targets). Nothing is written here.
   */
  async planUpdate(principal: Principal, id: string, input: QueuePatch, baseline: QueueBaseline = {}): Promise<{ stops: QueueStops; change: QueueApprovalPatch }> {
    assertCan(principal, Permission.QUEUES_MANAGE);
    const { teamIds, transferTargetIds, ...fields } = input;
    const [before] = await this.db.select().from(queues).where(eq(queues.id, id));
    if (!before) throw notFound('queue', id);
    const currentTeams = await assertQueueInScope(this.db, principal, before);
    // Read against the baseline: what the editor never saw stays (a stale form removes nothing new).
    const keepUnseen = (wanted: readonly string[], current: readonly string[], seen: readonly string[] | undefined) =>
      seen ? [...new Set([...wanted, ...current.filter((x) => !seen.includes(x))])] : [...new Set(wanted)];
    const wantedTeams = teamIds ? keepUnseen(teamIds, currentTeams, baseline.teamIds) : null;
    const { added, removed } = wantedTeams ? assertTeamChange(principal, currentTeams, wantedTeams) : { added: [], removed: [] };
    if (fields.agentId && fields.agentId !== before.agentId) await assertAgentAssignable(this.db, principal, fields.agentId);
    await assertQueueRefs(this.db, id, { agentId: fields.agentId, transferTargetIds });
    const targets = transferTargetIds ? keepUnseen(transferTargetIds, before.transferTargetIds, baseline.transferTargetIds) : null;
    const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && canonical(v) !== canonical((before as Record<string, unknown>)[k]))) as QueueApprovalPatch;
    if (changed.attributes && canonical(normalizeAttributes(changed.attributes)) === canonical(before.attributes)) delete changed.attributes;
    return {
      stops: { removeTeamIds: removed, removeTransferTargetIds: targets ? before.transferTargetIds.filter((t) => !targets.includes(t)) : [] },
      change: { ...changed, ...(added.length ? { addTeamIds: added } : {}), ...(targets?.some((t) => !before.transferTargetIds.includes(t)) ? { addTransferTargetIds: targets.filter((t) => !before.transferTargetIds.includes(t)) } : {}) },
    };
  }

  /** Stops: immediate, never gated, never locked by an open proposal. */
  async applyStops(actor: ActorContext, id: string, stops: QueueStops): Promise<void> {
    if (!stops.removeTeamIds.length && !stops.removeTransferTargetIds.length) return;
    await this.db.transaction(async (tx) => {
      if (!(await lockQueue(tx, id))) throw notFound('queue', id);
      await applyQueueStops(tx, actor, id, stops);
    });
  }

  /** The approvable change applied directly — only while the queue is a draft (else 409 approval_required / approval_open). */
  async applyChange(actor: ActorContext, id: string, change: QueueApprovalPatch): Promise<void> {
    if (isEmptyPatch(change)) return;
    await this.guarded(change.name ?? '', async (tx) => {
      const before = await lockQueue(tx, id);
      if (!before) throw notFound('queue', id);
      await assertChangeAllowed(tx, queueApproval, id, 'UPDATE');
      await applyQueuePatch(tx, actor, id, change, 'direct');
    });
  }

  /** Direct PATCH (seeds, tests, drafts): the stops, then the change — which answers approval_required once approved. */
  async update(actor: ActorContext, id: string, input: QueuePatch, baseline: QueueBaseline = {}): Promise<void> {
    const plan = await this.planUpdate(actor.principal!, id, input, baseline);
    await this.applyStops(actor, id, plan.stops);
    await this.applyChange(actor, id, plan.change);
  }

  /** One transaction; unique-index violations become readable conflicts. */
  private async guarded(name: string, fn: (tx: DbOrTx) => Promise<void>): Promise<void> {
    try {
      await this.db.transaction(fn);
    } catch (err) {
      const constraint = (err as { constraint?: string; cause?: { constraint?: string } }).constraint ?? (err as { cause?: { constraint?: string } }).cause?.constraint;
      if (constraint === 'queues_attributes_uq') throw conflict('queue_attributes_taken', 'Another queue already serves exactly these attributes');
      if (constraint === 'queues_name_uq') throw conflict('queue_name_taken', `A queue named ${name} already exists`);
      throw err;
    }
  }

  async listSlaPolicies() {
    const rows = await this.db.select().from(slaPolicies).orderBy(asc(slaPolicies.name));
    const approvals = await approvalSummaries(this.db, 'sla_policy', rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, approval: approvals.get(r.id) ?? { approved: false, pending: null } }));
  }

  /** A new policy is a draft (direct); changing one approved or used by a live queue is a proposal (409 approval_required here). */
  async saveSlaPolicy(actor: ActorContext, id: string | null, input: SlaPolicyInput): Promise<string> {
    assertCan(actor.principal!, Permission.SLA_MANAGE);
    const policyId = id ?? uuidv7();
    await this.db.transaction(async (tx) => {
      if (id) {
        if (!(await lockSlaPolicy(tx, id))) throw notFound('sla_policy', id);
        await assertChangeAllowed(tx, slaPolicyApproval, id, 'UPDATE');
        await applySlaPolicy(tx, actor, id, input, 'direct');
        return;
      }
      await tx.insert(slaPolicies).values({ id: policyId, ...input });
      await recordAudit(tx, actor, { action: 'sla_policy.create', targetType: 'sla_policy', targetId: policyId, summary: `SLA policy ${input.name}`, after: input });
    });
    return policyId;
  }

  async queuesForTeams(teamIds: readonly string[]): Promise<string[]> {
    if (!teamIds.length) return [];
    const rows = await this.db.select({ queueId: queueTeams.queueId }).from(queueTeams).where(inArray(queueTeams.teamId, [...teamIds]));
    return [...new Set(rows.map((r) => r.queueId))];
  }
}

/** Key-order-independent JSON (jsonb reorders object keys), so an unchanged field is never a change. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)])) : v;
  return JSON.stringify(sort(value ?? null));
}

/** The agent exists; transfer targets exist and are not the queue itself. */
async function assertQueueRefs(tx: DbOrTx, queueId: string, fields: { agentId?: string | null | undefined; transferTargetIds?: readonly string[] | undefined }): Promise<void> {
  if (fields.agentId) {
    const [agent] = await tx.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.id, fields.agentId));
    if (!agent) throw notFound('agent', fields.agentId);
  }
  const targets = [...new Set(fields.transferTargetIds ?? [])];
  if (targets.includes(queueId)) throw validation('transfer_target_self', 'A queue cannot transfer to itself');
  if (targets.length) {
    const found = await tx.select({ id: queues.id }).from(queues).where(inArray(queues.id, targets));
    const missing = targets.find((t) => !found.some((f) => f.id === t));
    if (missing) throw notFound('queue', missing);
  }
}
