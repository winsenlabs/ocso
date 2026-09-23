import { and, asc, desc, eq, gt, isNotNull, ne } from 'drizzle-orm';
import { advanceSession, isPassThrough, newSession, returningDue, type ControlState } from '@ocso/domain';
import { conversationRouting, conversations, queues, uuidv7, type DbOrTx } from '@ocso/db';
import { applyControl, type ConversationRow } from '../conversations/control.js';
import { emitEvent } from '../events/outbox.js';
import { loadQueue, resolutionDueFor } from '../handoffs/routing.js';
import { systemActor } from '../shared/context.js';
import { loadActiveRouter, type ActiveRouter } from './router-load.js';
import { decidedQueue, handOffUnanswered, provisionalType } from './routing-apply.js';
import { knownContext, startRoutingRow } from './routing-state.js';

export interface AdmitInput {
  channel: { id: string; name: string };
  customerId: string;
  now: Date;
  correlationId: string;
  /** A RESOLVED conversation is reopened if the customer writes within this window. */
  reopenWindowHours: number;
}

export type AdmitResult =
  | {
      status: 'admitted';
      conversationId: string;
      created: boolean;
      /** The conversation's agent (null while a step router decides). */
      agentId: string | null;
      queueId: string | null;
      /** A router is deciding: publish `conversation.route` instead of a turn. */
      route: boolean;
    }
  | { status: 'rejected'; reason: 'no_router'; detail: string };

const actorFor = (active: ActiveRouter, correlationId: string) => systemActor(`router:${active.router.id}`, correlationId, active.router.name);

/**
 * Where an inbound customer message goes (PM/research/11 §5.3): into the
 * customer's open conversation on this channel, a recently resolved one
 * (reopened), or a new one. Pass-through routers decide here, synchronously,
 * exactly as a channel's agent did before routers; routers with steps create
 * the conversation in ROUTING and the worker asks. A returning customer (gap
 * ≥ the router's `askAfter`) is asked continue-or-new first.
 *
 * Conversations already under way never depend on the channel's router: a
 * disabled or detached router stops new conversations only (`no_router`),
 * while customers mid-conversation (with the AI, a person, or a menu running
 * on its pinned version) keep reaching it.
 * Runs in the ingress transaction, before the message is appended.
 */
export async function admitConversation(tx: DbOrTx, input: AdmitInput): Promise<AdmitResult> {
  const scope = and(eq(conversations.customerId, input.customerId), eq(conversations.channelId, input.channel.id));
  const [open] = await tx.select().from(conversations).where(and(scope, ne(conversations.controlState, 'RESOLVED'))).for('update').limit(1);
  if (open?.controlState === 'ROUTING') return admitted(open, false, true);

  const windowStart = new Date(input.now.getTime() - input.reopenWindowHours * 3_600_000);
  // A conversation resolved while its router was still deciding has no agent to reopen to: the customer starts anew.
  const [recent] = open
    ? []
    : await tx
        .select()
        .from(conversations)
        .where(and(scope, eq(conversations.controlState, 'RESOLVED'), gt(conversations.resolvedAt, windowStart), isNotNull(conversations.agentId)))
        .orderBy(desc(conversations.resolvedAt))
        .limit(1);
  const existing = open ?? recent;
  const active = await loadActiveRouter(tx, input.channel.id);
  const returning = active?.definition.returning ?? null;
  if (existing && active && returning && (existing.controlState === 'AI_ACTIVE' || existing.controlState === 'RESOLVED') && returningDue(returning.askAfter, existing.lastCustomerMessageAt, input.now)) {
    await startReturning(tx, existing, active, input);
    return admitted(existing, false, true);
  }
  if (open) return admitted(open, false, false);
  if (recent) {
    // Conversations from before routing may have no queue: they reopen into a queue their agent serves.
    const queueId = recent.queueId ?? (await agentQueue(tx, recent.agentId!));
    await applyControl(tx, recent.id, {
      command: 'REOPEN',
      actor: systemActor('ingress', input.correlationId),
      transitionActor: 'CUSTOMER',
      reopenedBy: 'CUSTOMER',
      description: 'customer wrote again · conversation reopened',
      // A reopened conversation gets a fresh resolution window.
      patch: { queueId, resolutionDueAt: await resolutionDueFor(tx, await loadQueue(tx, queueId), recent.type, input.now) },
      now: input.now,
    });
    return admitted({ ...recent, queueId }, false, false);
  }
  if (!active) return { status: 'rejected', reason: 'no_router', detail: `channel ${input.channel.name} has no active router` };
  return openNew(tx, active, input);
}

/** A queue the agent serves (oldest first), for conversations that predate routing. */
async function agentQueue(tx: DbOrTx, agentId: string): Promise<string | null> {
  const [row] = await tx.select({ id: queues.id }).from(queues).where(eq(queues.agentId, agentId)).orderBy(asc(queues.createdAt)).limit(1);
  return row?.id ?? null;
}

function admitted(conv: Pick<ConversationRow, 'id' | 'agentId' | 'queueId'>, created: boolean, route: boolean): AdmitResult {
  return { status: 'admitted', conversationId: conv.id, created, agentId: conv.agentId, queueId: conv.queueId, route };
}

/** ROUTE_START into the continue-or-new question; the agent's unanswered messages begin after its last answer. */
async function startReturning(tx: DbOrTx, conv: ConversationRow, active: ActiveRouter, input: AdmitInput): Promise<void> {
  await applyControl(tx, conv.id, {
    command: 'ROUTE_START',
    actor: actorFor(active, input.correlationId),
    transitionActor: 'SYSTEM',
    description: 'returning customer · asking whether to continue or start new',
    // The router consumes replies from here on; completion hands the agent everything after seqFrom.
    patch: { lastProcessedSeq: conv.lastSeq },
    now: input.now,
  });
  await startRoutingRow(tx, { conversationId: conv.id, active, phase: 'RETURNING', previousState: conv.controlState as ControlState, seqFrom: Math.min(conv.lastProcessedSeq, conv.lastSeq), now: input.now });
}

async function openNew(tx: DbOrTx, active: ActiveRouter, input: AdmitInput): Promise<AdmitResult> {
  const id = uuidv7();
  const actor = actorFor(active, input.correlationId);
  const base = { id, customerId: input.customerId, channelId: input.channel.id, openedAt: input.now, lastInteractionAt: input.now };
  if (!isPassThrough(active.definition)) {
    await tx.insert(conversations).values({ ...base, agentId: null, type: await provisionalType(tx, active), controlState: 'ROUTING', queueId: null });
    await startRoutingRow(tx, { conversationId: id, active, phase: 'STEPS', previousState: null, seqFrom: 0, now: input.now });
    await emitEvent(tx, actor, 'conversation.created', { customerId: input.customerId, channelId: input.channel.id, queueId: null }, { conversationId: id });
    return { status: 'admitted', conversationId: id, created: true, agentId: null, queueId: null, route: true };
  }
  // Pass-through: rules without steps see no attributes except KNOWN ones (none), so this is the fallback or an unconditional rule.
  const { actions } = advanceSession(active.definition, newSession('STEPS'), { type: 'START' }, await knownContext(tx, input.customerId));
  const decision = actions.find((a) => a.type === 'DECIDE');
  const target = decision?.type === 'DECIDE' ? await decidedQueue(tx, decision.queueId, active.definition.fallbackQueueId) : null;
  if (!decision || decision.type !== 'DECIDE' || !target) {
    return { status: 'rejected', reason: 'no_router', detail: `router ${active.router.name} has no queue with an agent to route to` };
  }
  const { queue, agent } = target;
  const outcome = queue.id === decision.queueId ? decision.outcome : 'FALLBACK';
  await tx.insert(conversations).values({
    ...base,
    agentId: agent.id,
    type: agent.conversationType,
    controlState: 'AI_ACTIVE',
    queueId: queue.id,
    resolutionDueAt: await resolutionDueFor(tx, queue, agent.conversationType, input.now),
  });
  await tx.insert(conversationRouting).values({
    conversationId: id,
    routerId: active.router.id,
    routerVersionId: active.version.id,
    phase: 'DONE',
    outcome,
    ruleIndex: queue.id === decision.queueId ? decision.ruleIndex : null,
    queueId: queue.id,
    decidedAt: input.now,
    updatedAt: input.now,
  });
  await emitEvent(tx, actor, 'conversation.created', { customerId: input.customerId, channelId: input.channel.id, queueId: queue.id }, { conversationId: id, agentId: agent.id });
  // The decision's durable record (conversation_routing is reset if the customer later returns).
  await emitEvent(
    tx,
    actor,
    'conversation.routed',
    { routerId: active.router.id, routerVersionId: active.version.id, queueId: queue.id, agentId: agent.id, outcome, ruleIndex: queue.id === decision.queueId ? decision.ruleIndex : null },
    { conversationId: id, agentId: agent.id },
  );
  if (!target.live) await handOffUnanswered(tx, actor, id, target, input.now);
  return { status: 'admitted', conversationId: id, created: true, agentId: agent.id, queueId: queue.id, route: false };
}
