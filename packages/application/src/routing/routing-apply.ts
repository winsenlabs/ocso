import { eq } from 'drizzle-orm';
import type { ControlState, DecideOutcome } from '@ocso/domain';
import { conversationRouting, conversations, queues, virtualAgents, uuidv7, type DbOrTx } from '@ocso/db';
import { applyControl, type ConversationRow } from '../conversations/control.js';
import { appendInteraction, appendSystemEvent } from '../conversations/interaction-writer.js';
import { emitEvent } from '../events/outbox.js';
import { requestHandoff } from '../handoffs/request.js';
import { resolutionDueFor } from '../handoffs/routing.js';
import { systemActor, type ActorContext } from '../shared/context.js';
import { startRoutingRow, type CustomerMessage, type RoutingRow } from './routing-state.js';
import type { ActiveRouter } from './router-load.js';

export type QueueRow = typeof queues.$inferSelect;
export type AgentRow = typeof virtualAgents.$inferSelect;

export interface ServingQueue {
  queue: QueueRow;
  agent: AgentRow;
  /** The agent answers now (LIVE with a model profile); otherwise a person takes the conversation. */
  live: boolean;
}

/** An agent the turn processor will run (it skips any other). */
export const agentAnswers = (agent: Pick<AgentRow, 'status' | 'modelProfileId'>): boolean => agent.status === 'LIVE' && agent.modelProfileId !== null;

/** A queue that can take conversations: it exists and has its AI agent. */
export async function servingQueue(tx: DbOrTx, queueId: string): Promise<ServingQueue | null> {
  const [row] = await tx.select({ queue: queues, agent: virtualAgents }).from(queues).innerJoin(virtualAgents, eq(virtualAgents.id, queues.agentId)).where(eq(queues.id, queueId));
  return row ? { ...row, live: agentAnswers(row.agent) } : null;
}

/**
 * The decided queue if its agent answers, else the router's fallback if its
 * agent answers; else whichever of the two still has an agent (a person then
 * takes the conversation, see `completeRoute`). Null when neither has an agent.
 */
export async function decidedQueue(tx: DbOrTx, queueId: string, fallbackQueueId: string): Promise<ServingQueue | null> {
  const decided = await servingQueue(tx, queueId);
  if (decided?.live) return decided;
  const fallback = queueId === fallbackQueueId ? decided : await servingQueue(tx, fallbackQueueId);
  if (fallback?.live) return fallback;
  return decided ?? fallback;
}

/**
 * The queue's agent cannot answer (paused, draft, no model): open a human
 * handoff on the queue at once instead of leaving the customer with an AI that
 * never replies. The conversation must be AI_ACTIVE (just routed).
 */
export async function handOffUnanswered(tx: DbOrTx, actor: ActorContext, conversationId: string, target: ServingQueue, now: Date): Promise<void> {
  await requestHandoff(
    tx,
    actor,
    conversationId,
    {
      trigger: 'POLICY',
      reasonCode: 'agent_unavailable',
      reasonText: `${target.agent.name} is not answering (${target.agent.status.toLowerCase()}) · a person takes it`,
      requestedBy: { type: 'SYSTEM', id: null },
    },
    now,
  );
}

const routerActor = (routerId: string | null, correlationId: string) => systemActor(routerId ? `router:${routerId}` : 'router', correlationId, 'Router');

/**
 * ROUTE_COMPLETE (PM/research/11 §5.3): the conversation joins the queue and
 * its agent, gets the queue's resolution deadline and a timeline entry
 * ("Routed to Tamil Sales — rule 2: language=ta"), and the agent answers every
 * customer message since routing started. The caller publishes the turn
 * when this returns 'AI'. When the chosen agent cannot answer (paused, draft)
 * a human handoff opens on its queue ('HUMAN'). Returns null (nothing
 * changed) when neither queue has an agent: the caller keeps routing pending.
 */
export async function completeRoute(
  tx: DbOrTx,
  input: { conversation: ConversationRow; row: RoutingRow; active: ActiveRouter; queueId: string; outcome: DecideOutcome; ruleIndex: number | null; reason: string; correlationId: string; now: Date },
): Promise<'AI' | 'HUMAN' | null> {
  const target = await decidedQueue(tx, input.queueId, input.active.definition.fallbackQueueId);
  if (!target) return null;
  const { queue, agent } = target;
  const conv = input.conversation;
  const actor = routerActor(input.active.router.id, input.correlationId);
  const fellBack = queue.id !== input.queueId;
  const reason = fellBack ? `${input.reason} · queue had no answering agent, used the fallback` : input.reason;
  await applyControl(tx, conv.id, {
    command: 'ROUTE_COMPLETE',
    actor,
    transitionActor: 'SYSTEM',
    description: `routed to ${queue.name} (${agent.name}) — ${reason}`,
    patch: {
      queueId: queue.id,
      agentId: agent.id,
      resolutionDueAt: await resolutionDueFor(tx, queue, agent.conversationType, conv.openedAt),
      lastProcessedSeq: input.row.seqFrom,
    },
    now: input.now,
  });
  await tx.update(conversations).set({ type: agent.conversationType }).where(eq(conversations.id, conv.id));
  await tx
    .update(conversationRouting)
    .set({ phase: 'DONE', awaitingSince: null, outcome: fellBack ? 'FALLBACK' : input.outcome, ruleIndex: fellBack ? null : input.ruleIndex, queueId: queue.id, decidedAt: input.now, updatedAt: input.now })
    .where(eq(conversationRouting.conversationId, conv.id));
  await appendSystemEvent(
    tx,
    conv.id,
    'system.routed',
    `Routed to ${queue.name} — ${reason}`,
    { routerId: input.active.router.id, routerVersionId: input.active.version.id, queueId: queue.id, agentId: agent.id, outcome: fellBack ? 'FALLBACK' : input.outcome, ruleIndex: input.ruleIndex },
    input.correlationId,
    input.now,
  );
  await emitEvent(
    tx,
    actor,
    'conversation.routed',
    { routerId: input.active.router.id, routerVersionId: input.active.version.id, queueId: queue.id, agentId: agent.id, outcome: fellBack ? 'FALLBACK' : input.outcome, ruleIndex: fellBack ? null : input.ruleIndex },
    { conversationId: conv.id, agentId: agent.id },
  );
  if (target.live) return 'AI';
  await handOffUnanswered(tx, actor, conv.id, target, input.now);
  return 'HUMAN';
}

/**
 * ROUTE_CONTINUE: the returning customer continues where they were (a
 * resolved conversation reopens to the AI); the agent answers what they wrote.
 */
export async function continueRoute(
  tx: DbOrTx,
  input: { conversation: ConversationRow; row: RoutingRow; outcome: 'CONTINUE' | 'TIMEOUT'; correlationId: string; now: Date },
): Promise<void> {
  const { conversation: conv, row } = input;
  const previous = (row.previousState ?? 'AI_ACTIVE') as ControlState;
  const reopened = previous === 'RESOLVED';
  const queue = conv.queueId ? (await tx.select().from(queues).where(eq(queues.id, conv.queueId)))[0] ?? null : null;
  await applyControl(tx, conv.id, {
    command: 'ROUTE_CONTINUE',
    actor: routerActor(row.routerId, input.correlationId),
    transitionActor: 'SYSTEM',
    restoreState: previous,
    description: `${input.outcome === 'TIMEOUT' ? 'no answer to continue-or-new · continuing' : 'customer continues the conversation'}${reopened ? ' · reopened' : ''}`,
    patch: {
      lastProcessedSeq: row.seqFrom,
      // A reopened conversation gets a fresh resolution window (as a customer reopen does).
      ...(reopened ? { resolutionDueAt: await resolutionDueFor(tx, queue, conv.type, input.now) } : {}),
    },
    now: input.now,
  });
  await tx
    .update(conversationRouting)
    .set({ phase: 'DONE', awaitingSince: null, outcome: input.outcome === 'TIMEOUT' ? 'TIMEOUT' : 'CONTINUE', queueId: conv.queueId, decidedAt: input.now, updatedAt: input.now })
    .where(eq(conversationRouting.conversationId, conv.id));
  if (conv.agentId && conv.queueId) {
    await emitEvent(
      tx,
      routerActor(row.routerId, input.correlationId),
      'conversation.routed',
      { routerId: row.routerId, routerVersionId: row.routerVersionId, queueId: conv.queueId, agentId: conv.agentId, outcome: input.outcome, ruleIndex: null },
      { conversationId: conv.id, agentId: conv.agentId },
    );
  }
}

export const STARTED_NEW_DISPOSITION = 'CUSTOMER_STARTED_NEW';

/** Provisional type of a conversation still routing: its fallback queue agent's type. */
export async function provisionalType(tx: DbOrTx, active: ActiveRouter): Promise<string> {
  return (await servingQueue(tx, active.definition.fallbackQueueId))?.agent.conversationType ?? 'SUPPORT';
}

/**
 * The returning customer chose "new": the old conversation is resolved
 * (disposition CUSTOMER_STARTED_NEW) and a new one starts routing from its
 * first step, carrying copies of the messages that brought the customer back
 * (idempotency keys suffixed `:carried`). Returns the new conversation id.
 */
export async function startNewConversation(
  tx: DbOrTx,
  input: { conversation: ConversationRow; row: RoutingRow; active: ActiveRouter; carried: readonly CustomerMessage[]; correlationId: string; now: Date },
): Promise<string> {
  const { conversation: old, now } = input;
  const actor = routerActor(input.active.router.id, input.correlationId);
  await tx
    .update(conversationRouting)
    .set({ phase: 'DONE', awaitingSince: null, outcome: 'NEW', decidedAt: now, updatedAt: now })
    .where(eq(conversationRouting.conversationId, old.id));
  // A conversation that was already resolved goes back to exactly that (its resolution time,
  // disposition and reopen count untouched; ROUTE_START never counted as a reopen): no second resolution.
  const wasResolved = input.row.previousState === 'RESOLVED' && old.resolvedAt !== null;
  await applyControl(tx, old.id, {
    command: 'RESOLVE',
    actor,
    transitionActor: 'SYSTEM',
    description: wasResolved ? 'customer started a new conversation · this one stays resolved' : 'customer started a new conversation',
    patch: wasResolved ? { waitingSince: null } : { resolvedAt: now, disposition: STARTED_NEW_DISPOSITION, waitingSince: null },
    now,
  });
  if (!wasResolved) await emitEvent(tx, actor, 'conversation.resolved', { disposition: STARTED_NEW_DISPOSITION, resolvedBy: null }, { conversationId: old.id, agentId: old.agentId });

  const id = uuidv7();
  await tx.insert(conversations).values({
    id,
    customerId: old.customerId,
    agentId: null,
    channelId: old.channelId,
    type: await provisionalType(tx, input.active),
    controlState: 'ROUTING',
    queueId: null,
    openedAt: now,
    lastInteractionAt: now,
  });
  for (const message of input.carried) {
    await appendInteraction(
      tx,
      id,
      {
        actorType: 'CUSTOMER',
        actorId: old.customerId,
        direction: 'INBOUND',
        visibility: 'CUSTOMER',
        idempotencyKey: `${message.idempotencyKey ?? `interaction:${message.id}`}:carried`,
        correlationId: input.correlationId,
        parts: message.parts,
      },
      { channelId: old.channelId, now },
    );
  }
  await startRoutingRow(tx, { conversationId: id, active: input.active, phase: 'STEPS', previousState: null, seqFrom: 0, now });
  await emitEvent(tx, actor, 'conversation.created', { customerId: old.customerId, channelId: old.channelId, queueId: null }, { conversationId: id });
  return id;
}
