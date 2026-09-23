import { and, eq, inArray, sql } from 'drizzle-orm';
import { AttrKey, BusinessHoursSchema, conflict, notFound } from '@ocso/domain';
import { queueTeams, queues, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { lockObject } from '../approvals/guard.js';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { isLiveQueue } from './queue-guards.js';
import type { ActorContext } from '../shared/context.js';

/**
 * Queue writes shared by the direct path (a draft queue), the approval
 * activation (PM/research/11 §5.5, wave 2) and the stop path. A queue change
 * is expressed as a *delta* for its lists: teams and transfer targets are
 * only ever added by an approvable change and removed by a stop — so a stop
 * taken while a proposal is open is never undone by approving it.
 */

export type QueueRecord = typeof queues.$inferSelect;

/** The approvable part of a queue change (the proposal payload). Removals are stops and never in it. */
export const QueueApprovalPatch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(500).nullable().optional(),
  mode: z.enum(['AUTO_ASSIGN', 'OPEN_PICKUP']).optional(),
  autoAssignAfterSeconds: z.number().int().min(10).max(86_400).nullable().optional(),
  acceptTimeoutSeconds: z.number().int().min(15).max(3_600).optional(),
  requiredSkills: z.array(z.string().max(60)).max(20).optional(),
  languages: z.array(z.string().max(20)).max(20).optional(),
  preferAccountOwner: z.boolean().optional(),
  slaPolicyId: z.uuid().nullable().optional(),
  agentId: z.uuid().nullable().optional(),
  attributes: z.record(AttrKey, z.string().trim().min(1).max(60)).optional(),
  businessHours: BusinessHoursSchema.nullable().optional(),
  /** Teams that start serving the queue (staffing). */
  addTeamIds: z.array(z.uuid()).max(50).optional(),
  /** Queues conversations may newly be transferred to. */
  addTransferTargetIds: z.array(z.uuid()).max(50).optional(),
});
export type QueueApprovalPatch = z.infer<typeof QueueApprovalPatch>;

/** Stops: never proposals, never locked by an open one (§4.5). */
export interface QueueStops {
  removeTeamIds: string[];
  removeTransferTargetIds: string[];
}

/** Attribute values are compared case-insensitively by routers; stored lower case so the unique index agrees. */
export function normalizeAttributes(attributes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(attributes).map(([k, v]) => [k, v.trim().toLowerCase()]));
}

/** Every writer of a queue's configuration takes this: the approval key, then the row. */
export async function lockQueue(tx: DbOrTx, queueId: string): Promise<QueueRecord | null> {
  await lockObject(tx, `queue:${queueId}`);
  const [row] = await tx.select().from(queues).where(eq(queues.id, queueId)).for('update');
  return row ?? null;
}

export async function queueTeamIds(tx: DbOrTx, queueId: string): Promise<string[]> {
  return (await tx.select({ teamId: queueTeams.teamId }).from(queueTeams).where(eq(queueTeams.queueId, queueId))).map((r) => r.teamId).sort();
}

/** True when the patch changes nothing on this queue (the empty remainder of a stop-only PATCH). */
export function isEmptyPatch(patch: QueueApprovalPatch): boolean {
  return Object.entries(patch).every(([, v]) => v === undefined || (Array.isArray(v) && v.length === 0));
}

/** Apply an approvable change (direct for a draft queue, or on approval). Audited; caller holds the lock. */
export async function applyQueuePatch(tx: DbOrTx, actor: ActorContext, queueId: string, patch: QueueApprovalPatch, how: 'direct' | 'approved'): Promise<void> {
  const [before] = await tx.select().from(queues).where(eq(queues.id, queueId));
  if (!before) throw notFound('queue', queueId);
  const teamsBefore = await queueTeamIds(tx, queueId);
  const { addTeamIds = [], addTransferTargetIds = [], attributes, ...fields } = patch;
  const targets = [...new Set([...before.transferTargetIds, ...addTransferTargetIds])].filter((t) => t !== queueId);
  const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  await tx
    .update(queues)
    .set({ ...set, ...(attributes ? { attributes: normalizeAttributes(attributes) } : {}), ...(addTransferTargetIds.length ? { transferTargetIds: targets } : {}), updatedAt: new Date() })
    .where(eq(queues.id, queueId));
  const newTeams = addTeamIds.filter((t) => !teamsBefore.includes(t));
  if (newTeams.length) await tx.insert(queueTeams).values(newTeams.map((teamId) => ({ queueId, teamId }))).onConflictDoNothing();
  await recordAudit(tx, actor, {
    action: 'queue.update',
    targetType: 'queue',
    targetId: queueId,
    summary: `Updated queue ${before.name}${how === 'approved' ? ' (approved)' : ''}`,
    before: { ...before, teamIds: teamsBefore },
    after: patch,
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'queue', entityId: queueId });
}

/**
 * Stops: unlink teams, drop transfer targets. Immediate; caller holds the row lock. `updated_at` is left
 * alone: it is the approval dependency stamp, and a stop must not void a router proposal routing here.
 */
export async function applyQueueStops(tx: DbOrTx, actor: ActorContext, queueId: string, stops: QueueStops): Promise<void> {
  const [before] = await tx.select().from(queues).where(eq(queues.id, queueId));
  if (!before) throw notFound('queue', queueId);
  const teamsBefore = await queueTeamIds(tx, queueId);
  const teams = stops.removeTeamIds.filter((t) => teamsBefore.includes(t));
  const targets = stops.removeTransferTargetIds.filter((t) => before.transferTargetIds.includes(t));
  if (!teams.length && !targets.length) return;
  // Unlinking your team reduces your rights; leaving a live queue with no team at all strands its handoffs
  // (nobody can claim them) — that degrades live service rather than stopping something.
  if (teams.length && teams.length === teamsBefore.length && (await isLiveQueue(tx, queueId))) {
    throw conflict('queue_last_team', `${before.name} is live: link another team before unlinking the last one, or stop the traffic first (disable its router or pause its agent).`);
  }
  if (teams.length) await tx.delete(queueTeams).where(and(eq(queueTeams.queueId, queueId), inArray(queueTeams.teamId, teams)));
  if (targets.length) {
    await tx
      .update(queues)
      .set({ transferTargetIds: sql`ARRAY(SELECT t FROM unnest(${queues.transferTargetIds}) AS t WHERE NOT (t = ANY(${sql`ARRAY[${sql.join(targets.map((t) => sql`${t}::uuid`), sql`, `)}]::uuid[]`})))` })
      .where(eq(queues.id, queueId));
  }
  await recordAudit(tx, actor, {
    action: 'queue.reduce',
    targetType: 'queue',
    targetId: queueId,
    summary: `Queue ${before.name}: ${[teams.length ? `unlinked ${teams.length} team(s)` : '', targets.length ? `removed ${targets.length} transfer target(s)` : ''].filter(Boolean).join(', ')}`,
    before: { teamIds: teamsBefore, transferTargetIds: before.transferTargetIds },
    after: { removedTeamIds: teams, removedTransferTargetIds: targets },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'queue', entityId: queueId });
}
