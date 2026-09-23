import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { pickupDueAt, resolutionDueAt, selectAssignee, type ConversationType, type ExecCandidate, type Priority, type SlaPolicy } from '@ocso/domain';
import { assignments, conversations, queueTeams, queues, slaPolicies, teamMembers, users, type DbOrTx } from '@ocso/db';

export type QueueRow = typeof queues.$inferSelect;

export async function loadQueue(tx: DbOrTx, queueId: string | null): Promise<QueueRow | null> {
  if (!queueId) return null;
  const [row] = await tx.select().from(queues).where(eq(queues.id, queueId));
  return row ?? null;
}

async function slaPolicyOf(tx: DbOrTx, queue: QueueRow | null): Promise<SlaPolicy | null> {
  if (!queue?.slaPolicyId) return null;
  const [policy] = await tx.select().from(slaPolicies).where(eq(slaPolicies.id, queue.slaPolicyId));
  if (!policy) return null;
  return {
    firstHumanResponseSeconds: policy.firstHumanResponseSeconds,
    pickupSecondsByPriority: policy.pickupSecondsByPriority,
    resolutionSecondsByType: policy.resolutionSecondsByType,
    atRiskFraction: policy.atRiskFraction,
  };
}

/** Pickup SLA due time for a queue + priority, or null when the queue has no SLA policy. */
export async function slaDueFor(tx: DbOrTx, queue: QueueRow | null, priority: Priority, from: Date): Promise<Date | null> {
  const sla = await slaPolicyOf(tx, queue);
  return sla ? pickupDueAt(sla, priority, from) : null;
}

/** Resolution SLA deadline for a conversation type, measured from when the conversation (re)opened. */
export async function resolutionDueFor(tx: DbOrTx, queue: QueueRow | null, type: string, openedAt: Date): Promise<Date | null> {
  const sla = await slaPolicyOf(tx, queue);
  return sla ? resolutionDueAt(sla, type as ConversationType, openedAt) : null;
}

/**
 * Eligible Service member candidates for a queue with live workload counts
 * (docs/09 §3). Workload = open conversations currently assigned.
 */
export async function queueCandidates(tx: DbOrTx, queueId: string): Promise<ExecCandidate[]> {
  const teamRows = await tx.select({ teamId: queueTeams.teamId }).from(queueTeams).where(eq(queueTeams.queueId, queueId));
  const teamIds = teamRows.map((t) => t.teamId);
  if (!teamIds.length) return [];
  const rows = await tx
    .select({
      id: users.id,
      availability: users.availability,
      maxConcurrent: users.maxConcurrent,
      skills: users.skills,
      languages: users.languages,
      lastAssignedAt: users.lastAssignedAt,
      teamIds: sql<string[]>`array_agg(${teamMembers.teamId})`,
      active: sql<number>`(SELECT count(*)::int FROM ${conversations} c WHERE c.assigned_user_id = ${users.id} AND c.control_state IN ('HUMAN_ACTIVE','WAITING_FOR_HUMAN','AI_RESUMING'))`,
    })
    .from(users)
    .innerJoin(teamMembers, eq(teamMembers.userId, users.id))
    .where(and(inArray(teamMembers.teamId, teamIds), eq(users.status, 'ACTIVE'), inArray(users.role, ['SERVICE', 'LEAD', 'HEAD'])))
    .groupBy(users.id);
  return rows.map((r) => ({
    userId: r.id,
    availability: r.availability,
    activeConversations: r.active,
    maxConcurrent: r.maxConcurrent,
    teamIds: r.teamIds,
    skills: r.skills,
    languages: r.languages,
    lastAssignedAt: r.lastAssignedAt,
  }));
}

export async function pickAssignee(
  tx: DbOrTx,
  queue: QueueRow,
  options: { preferredLanguage?: string | null | undefined; accountOwnerUserId?: string | null | undefined; exclude?: readonly string[] | undefined },
): Promise<{ userId: string; reasons: string[] } | null> {
  const candidates = await queueCandidates(tx, queue.id);
  return selectAssignee(candidates, {
    queueTeamIds: [...new Set(candidates.flatMap((c) => c.teamIds))],
    requiredSkills: queue.requiredSkills,
    preferredLanguage: options.preferredLanguage ?? undefined,
    accountOwnerUserId: queue.preferAccountOwner ? (options.accountOwnerUserId ?? undefined) : undefined,
    excludeUserIds: options.exclude,
  });
}

/** Close the currently open assignment for a conversation (if any). */
export async function endOpenAssignment(tx: DbOrTx, conversationId: string, reason: string, now: Date): Promise<void> {
  await tx
    .update(assignments)
    .set({ endedAt: now, endReason: reason })
    .where(and(eq(assignments.conversationId, conversationId), isNull(assignments.endedAt)));
}
