import { eq, sql } from 'drizzle-orm';
import { Permission } from '@ocso/auth';
import { queueTeams, queues, slaPolicies, type DbOrTx } from '@ocso/db';
import { describeDiff, diffFields, notFound } from '@ocso/domain';
import { z } from 'zod';
import type { ApprovalDescriptor, ProposalRow } from '../approvals/contract.js';
import { isApproved, lockObject } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { LIVE_QUEUE_IDS } from './queue-approval.js';

/**
 * The `sla_policy` approval kind (PM/research/11 §4.4), checked with
 * approvals.check.routing. A policy is created as a draft (a queue may name
 * it, but a queue's own approval requires the policy approved); CREATE is its
 * first approval; once approved — or while a live queue uses it — every
 * change is an UPDATE proposal carrying the whole policy. No stop action.
 */

export const SlaPolicyInput = z.object({
  name: z.string().trim().min(1).max(120),
  firstHumanResponseSeconds: z.number().int().min(30).max(604_800),
  pickupSecondsByPriority: z.partialRecord(z.enum(['P1', 'P2', 'P3', 'P4']), z.number().int().min(30).max(604_800)).default({}),
  resolutionSecondsByType: z.record(z.string(), z.number().int().min(60).max(2_592_000)).default({}),
  atRiskFraction: z.number().min(0.1).max(0.99).default(0.75),
});
export type SlaPolicyInput = z.infer<typeof SlaPolicyInput>;
type SlaRow = typeof slaPolicies.$inferSelect;

/** SLA policies live queues use (the exception report's "live"). */
const LIVE_SLA_IDS = sql`SELECT DISTINCT q.sla_policy_id AS id FROM ${queues} q WHERE q.sla_policy_id IS NOT NULL AND q.id IN (${LIVE_QUEUE_IDS})`;

export async function lockSlaPolicy(tx: DbOrTx, id: string): Promise<SlaRow | null> {
  await lockObject(tx, `sla_policy:${id}`);
  const [row] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, id)).for('update');
  return row ?? null;
}

/** Write the whole policy (direct for a draft, or on approval). Audited. */
export async function applySlaPolicy(tx: DbOrTx, actor: ActorContext, id: string, input: SlaPolicyInput, how: 'direct' | 'approved'): Promise<void> {
  const [before] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, id));
  if (!before) throw notFound('sla_policy', id);
  await tx.update(slaPolicies).set({ ...input, updatedAt: new Date() }).where(eq(slaPolicies.id, id));
  await recordAudit(tx, actor, { action: 'sla_policy.update', targetType: 'sla_policy', targetId: id, summary: `SLA policy ${input.name}${how === 'approved' ? ' (approved)' : ''}`, before, after: input });
  await emitEvent(tx, actor, 'config.changed', { area: 'sla_policy', entityId: id });
}

function view(p: Pick<SlaRow, 'name' | 'firstHumanResponseSeconds' | 'pickupSecondsByPriority' | 'resolutionSecondsByType' | 'atRiskFraction'>) {
  return {
    name: p.name,
    firstHumanResponseSeconds: p.firstHumanResponseSeconds,
    pickupSecondsByPriority: p.pickupSecondsByPriority,
    resolutionSecondsByType: p.resolutionSecondsByType,
    atRiskFraction: p.atRiskFraction,
  };
}

async function load(tx: DbOrTx, id: string): Promise<SlaRow | null> {
  const [row] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, id));
  return row ?? null;
}

async function usedByLiveQueue(tx: DbOrTx, id: string): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`SELECT id FROM (${LIVE_SLA_IDS}) s WHERE s.id = ${id}::uuid LIMIT 1`);
  return rows.rows.length > 0;
}

export const slaPolicyApproval: ApprovalDescriptor = {
  kind: 'sla_policy',
  label: 'SLA policy',
  actions: ['CREATE', 'UPDATE'],
  makePermission: () => Permission.SLA_MANAGE,
  checkPermission: Permission.APPROVALS_CHECK_ROUTING,
  // CREATE approves the draft as it is (an empty payload); UPDATE carries the whole policy.
  payload: z.union([SlaPolicyInput, z.object({}).strict()]),

  async requiresApproval(tx, id, action) {
    if (action !== 'UPDATE') return true;
    return (await isApproved(tx, 'sla_policy', id)) || usedByLiveQueue(tx, id);
  },
  async lock(tx, id) {
    await lockSlaPolicy(tx, id);
  },
  async project(tx, id) {
    const row = await load(tx, id);
    return row ? view(row) : null;
  },
  async projectAfter(tx, p: ProposalRow) {
    const row = await load(tx, p.objectId);
    if (!row) return null;
    return p.action === 'UPDATE' ? view({ ...row, ...(p.payload as SlaPolicyInput) }) : view(row);
  },
  /** Teams of the queues that use it (their Heads check); none → platform-wide. */
  async teamIds(tx, id) {
    const rows = await tx.selectDistinct({ teamId: queueTeams.teamId }).from(queueTeams).innerJoin(queues, eq(queues.id, queueTeams.queueId)).where(eq(queues.slaPolicyId, id));
    return rows.map((r) => r.teamId).sort();
  },
  dependencies: async () => [],
  async assertVisible(tx, _principal, id) {
    if (!(await load(tx, id))) throw notFound('sla_policy', id);
  },
  async validate(tx, p) {
    const row = await load(tx, p.objectId);
    if (!row) return [{ code: 'object_missing', message: 'The SLA policy no longer exists.' }];
    if (p.action === 'CREATE' && (await isApproved(tx, 'sla_policy', p.objectId))) return [{ code: 'already_approved', message: 'This SLA policy has already been approved.' }];
    if (p.action === 'UPDATE' && !SlaPolicyInput.safeParse(p.payload).success) return [{ code: 'invalid_payload', message: 'A change carries the whole policy.' }];
    return [];
  },
  async activate(tx, actor, p) {
    if (p.action === 'UPDATE') await applySlaPolicy(tx, actor, p.objectId, p.payload as SlaPolicyInput, 'approved');
    else {
      const row = await load(tx, p.objectId);
      await recordAudit(tx, actor, { action: 'sla_policy.approve', targetType: 'sla_policy', targetId: p.objectId, summary: `SLA policy ${row?.name ?? p.objectId} approved`, after: { proposalId: p.id } });
    }
    return { kind: 'DONE' };
  },
  async liveObjects(tx) {
    return (await tx.execute<{ id: string }>(LIVE_SLA_IDS)).rows.map((r) => r.id);
  },
  title(p, before) {
    const name = String(before?.['name'] ?? 'SLA policy');
    if (p.action === 'CREATE') return `Approve SLA policy ${name}`;
    return `Change SLA policy ${name}: ${describeDiff(diffFields(p.beforeSnapshot, p.afterSnapshot))}`;
  },
};
