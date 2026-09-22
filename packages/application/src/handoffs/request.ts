import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { raisePriority, type HandoffMode, type HandoffTrigger, type Priority } from '@ocso/domain';
import { assignments, conversations, customers, escalationRules, handoffs, users, virtualAgents, uuidv7, type DbOrTx } from '@ocso/db';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { applyControl } from '../conversations/control.js';
import { loadQueue, pickAssignee, slaDueFor } from './routing.js';

export interface HandoffRequest {
  trigger: HandoffTrigger;
  reasonCode: string;
  reasonText: string;
  /** Three-line summary for the human (what happened / what was done / what to decide). */
  agentSummary?: string | undefined;
  priority?: Priority | undefined;
  ruleId?: string | undefined;
  requestedBy: { type: 'AGENT' | 'SYSTEM' | 'HUMAN' | 'CUSTOMER'; id: string | null };
}

export interface HandoffOutcome {
  handoffId: string;
  queueId: string | null;
  mode: HandoffMode;
  offeredTo: string | null;
  alreadyOpen: boolean;
}

/**
 * Escalation → routing (docs/09 §3, docs/01 §6): AI_ACTIVE → ESCALATION_REQUESTED
 * → WAITING_FOR_HUMAN in one transaction, then an immediate auto-assign offer
 * when the queue (or rule) says AUTO_ASSIGN. Caller owns the transaction.
 */
export async function requestHandoff(tx: DbOrTx, actor: ActorContext, conversationId: string, req: HandoffRequest, now: Date): Promise<HandoffOutcome> {
  const [conv] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update');
  if (!conv) throw new Error(`conversation ${conversationId} not found`);
  const [open] = await tx
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), inArray(handoffs.status, ['REQUESTED', 'WAITING', 'OFFERED', 'ACTIVE'])))
    .orderBy(desc(handoffs.requestedAt))
    .limit(1);
  if (open || !['AI_ACTIVE', 'AI_RESUMING'].includes(conv.controlState)) {
    return { handoffId: open?.id ?? '', queueId: conv.queueId, mode: open?.mode ?? 'OPEN_PICKUP', offeredTo: conv.assignedUserId, alreadyOpen: true };
  }
  const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, conv.agentId));
  const rule = req.ruleId ? (await tx.select().from(escalationRules).where(eq(escalationRules.id, req.ruleId)))[0] : undefined;
  const queue = await loadQueue(tx, rule?.targetQueueId ?? agent?.defaultQueueId ?? conv.queueId);
  const mode: HandoffMode = rule?.mode ?? queue?.mode ?? 'OPEN_PICKUP';
  const priority = raisePriority(conv.priority, req.priority ?? rule?.priority ?? conv.priority);
  const transitionActor = req.requestedBy.type === 'CUSTOMER' ? 'SYSTEM' : req.requestedBy.type;

  await applyControl(tx, conversationId, {
    command: 'REQUEST_ESCALATION',
    actor,
    transitionActor,
    description: `escalation requested · reason: ${req.reasonText} · priority ${priority}`,
    patch: { priority },
    now,
  });
  const handoffId = uuidv7();
  await tx.insert(handoffs).values({
    id: handoffId,
    conversationId,
    trigger: req.trigger,
    reasonCode: req.reasonCode,
    reasonText: req.reasonText,
    ruleId: req.ruleId ?? null,
    requestedByType: req.requestedBy.type,
    requestedById: req.requestedBy.id,
    mode,
    queueId: queue?.id ?? null,
    priority,
    status: 'WAITING',
    agentSummary: req.agentSummary ?? null,
    requestedAt: now,
    routedAt: now,
    autoAssignAt: mode === 'OPEN_PICKUP' && queue?.autoAssignAfterSeconds ? new Date(now.getTime() + queue.autoAssignAfterSeconds * 1000) : null,
  });
  const slaDueAt = await slaDueFor(tx, queue, priority, now);
  await applyControl(tx, conversationId, {
    command: 'ROUTE_TO_QUEUE',
    actor,
    transitionActor: 'SYSTEM',
    description: `routed to queue “${queue?.name ?? 'unassigned'}” · mode ${mode}`,
    patch: { queueId: queue?.id ?? null, waitingSince: now, slaDueAt },
    now,
  });
  await emitEvent(tx, actor, 'handoff.requested', { handoffId, trigger: req.trigger, reason: req.reasonText, priority }, { conversationId, agentId: conv.agentId });

  let offeredTo: string | null = null;
  if (mode === 'AUTO_ASSIGN' && queue) offeredTo = await offerToNextExec(tx, actor, conversationId, handoffId, queue.id, [], now);
  return { handoffId, queueId: queue?.id ?? null, mode, offeredTo, alreadyOpen: false };
}

/**
 * Offer a waiting conversation to the best eligible exec (AUTO_ASSIGN). The
 * exec must accept within the queue's accept timeout or it is re-offered.
 */
export async function offerToNextExec(
  tx: DbOrTx,
  actor: ActorContext,
  conversationId: string,
  handoffId: string,
  queueId: string,
  exclude: readonly string[],
  now: Date,
): Promise<string | null> {
  const queue = await loadQueue(tx, queueId);
  if (!queue) return null;
  const [conv] = await tx
    .select({ c: conversations, language: customers.language, owner: customers.accountOwnerUserId })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(eq(conversations.id, conversationId));
  if (!conv || conv.c.controlState !== 'WAITING_FOR_HUMAN') return null;
  const pick = await pickAssignee(tx, queue, { preferredLanguage: conv.language, accountOwnerUserId: conv.owner, exclude });
  if (!pick) return null;
  await tx.update(conversations).set({ assignedUserId: pick.userId, updatedAt: now }).where(eq(conversations.id, conversationId));
  await tx
    .update(handoffs)
    .set({ status: 'OFFERED', assignedUserId: pick.userId, offeredAt: now, offerExpiresAt: new Date(now.getTime() + queue.acceptTimeoutSeconds * 1000) })
    .where(eq(handoffs.id, handoffId));
  await tx.insert(assignments).values({ id: uuidv7(), conversationId, userId: pick.userId, handoffId, kind: 'AUTO', assignedAt: now });
  await tx.update(users).set({ lastAssignedAt: now }).where(eq(users.id, pick.userId));
  await emitEvent(tx, actor, 'handoff.assigned', { handoffId, mode: 'AUTO_ASSIGN', queueId, userId: pick.userId }, { conversationId });
  await emitEvent(tx, actor, 'assignment.changed', { userId: pick.userId, previousUserId: null, kind: 'AUTO' }, { conversationId });
  return pick.userId;
}

/** Open (unresolved) handoff for a conversation. */
export async function openHandoff(tx: DbOrTx, conversationId: string) {
  const [row] = await tx
    .select()
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), isNull(handoffs.resolvedAt), isNull(handoffs.cancelledAt), isNull(handoffs.returnedAt)))
    .orderBy(desc(handoffs.requestedAt))
    .limit(1);
  return row ?? null;
}
