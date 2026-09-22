import { and, eq, isNotNull, lt, sql } from 'drizzle-orm';
import { conversations, handoffs, type Db } from '@ocso/db';
import { systemActor } from '../shared/context.js';
import { applyControl } from '../conversations/control.js';
import { endOpenAssignment } from './routing.js';
import { offerToNextExec } from './request.js';

/**
 * Periodic human-operations tasks run by the worker scheduler leader:
 * offer expiry (AUTO_ASSIGN accept timeout), pickup-then-auto-assign, and
 * re-offering waiting AUTO_ASSIGN conversations when capacity frees up.
 */
export async function expireOffers(db: Db, now = new Date()): Promise<number> {
  const expired = await db
    .select({ id: handoffs.id, conversationId: handoffs.conversationId, queueId: handoffs.queueId, assignedUserId: handoffs.assignedUserId, declined: handoffs.declinedUserIds })
    .from(handoffs)
    .where(and(eq(handoffs.status, 'OFFERED'), isNotNull(handoffs.offerExpiresAt), lt(handoffs.offerExpiresAt, now)))
    .limit(100);
  for (const h of expired) {
    await db.transaction(async (tx) => {
      const actor = systemActor('offer-expiry', `offer-expiry:${h.id}`);
      const exclude = h.assignedUserId ? [...h.declined, h.assignedUserId] : h.declined;
      await endOpenAssignment(tx, h.conversationId, 'offer_expired', now);
      await tx.update(conversations).set({ assignedUserId: null }).where(and(eq(conversations.id, h.conversationId), eq(conversations.controlState, 'WAITING_FOR_HUMAN')));
      await tx.update(handoffs).set({ status: 'WAITING', assignedUserId: null, declinedUserIds: exclude, offerExpiresAt: null }).where(eq(handoffs.id, h.id));
      if (h.queueId) await offerToNextExec(tx, actor, h.conversationId, h.id, h.queueId, exclude, now);
    });
  }
  return expired.length;
}

/** OPEN_PICKUP queues with auto-assign-after: offer unclaimed conversations once the delay passes. */
export async function autoAssignUnclaimed(db: Db, now = new Date()): Promise<number> {
  const due = await db
    .select({ id: handoffs.id, conversationId: handoffs.conversationId, queueId: handoffs.queueId, declined: handoffs.declinedUserIds })
    .from(handoffs)
    .innerJoin(conversations, eq(conversations.id, handoffs.conversationId))
    .where(
      and(
        eq(handoffs.status, 'WAITING'),
        isNotNull(handoffs.queueId),
        sql`(${handoffs.autoAssignAt} <= ${now} OR (${handoffs.mode} = 'AUTO_ASSIGN'))`,
        eq(conversations.controlState, 'WAITING_FOR_HUMAN'),
        sql`${conversations.assignedUserId} IS NULL`,
      ),
    )
    .limit(100);
  let offered = 0;
  for (const h of due) {
    const userId = await db.transaction((tx) =>
      offerToNextExec(tx, systemActor('auto-assign', `auto-assign:${h.id}`), h.conversationId, h.id, h.queueId!, h.declined, now),
    );
    if (userId) offered++;
  }
  return offered;
}

/** Cancel stale escalations stuck in ESCALATION_REQUESTED (routing crashed mid-way). */
export async function repairStuckEscalations(db: Db, olderThanSeconds = 60): Promise<number> {
  const stuck = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.controlState, 'ESCALATION_REQUESTED'), lt(conversations.updatedAt, new Date(Date.now() - olderThanSeconds * 1000))))
    .limit(50);
  for (const c of stuck) {
    await db.transaction((tx) =>
      applyControl(tx, c.id, {
        command: 'ROUTE_TO_QUEUE',
        actor: systemActor('escalation-repair', `repair:${c.id}`),
        transitionActor: 'SYSTEM',
        description: 'routing completed by recovery',
        patch: { waitingSince: new Date() },
        now: new Date(),
      }),
    );
  }
  return stuck.length;
}
