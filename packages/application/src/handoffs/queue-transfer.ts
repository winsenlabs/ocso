import { and, eq, inArray, isNotNull, max, ne, sql } from 'drizzle-orm';
import { validation } from '@ocso/domain';
import { approvalProposals, conversationSummaries, conversations, queues, virtualAgents, uuidv7, type DbOrTx } from '@ocso/db';
import { applyControl, lockConversation, type ConversationRow } from '../conversations/control.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { resolutionDueFor, type QueueRow } from './routing.js';

export interface TransferTarget {
  queue: QueueRow;
  agent: { id: string; name: string; conversationType: string } | null;
}

/** Queues a checker has approved (PM/research/11 §5.5: only approved queues are reachable by a transfer). */
export const approvedQueue = (column = queues.id) =>
  sql`${column} IN (SELECT ${approvalProposals.objectId} FROM ${approvalProposals} WHERE ${approvalProposals.objectKind} = 'queue' AND ${approvalProposals.status} = 'APPROVED')`;

/**
 * A queue, its agent (null when it has none, or when that agent is not LIVE: the conversation then keeps its
 * agent rather than moving to one that does not answer) and whether a checker has approved the queue.
 */
export async function transferTarget(tx: DbOrTx, queueId: string): Promise<(TransferTarget & { approved: boolean }) | null> {
  const [row] = await tx
    .select({ queue: queues, agentId: virtualAgents.id, agentName: virtualAgents.name, agentStatus: virtualAgents.status, conversationType: virtualAgents.conversationType, approved: sql<boolean>`${approvedQueue()}` })
    .from(queues)
    .leftJoin(virtualAgents, eq(virtualAgents.id, queues.agentId))
    .where(eq(queues.id, queueId));
  if (!row) return null;
  const agent = row.agentId && row.agentStatus === 'LIVE' ? { id: row.agentId, name: row.agentName!, conversationType: row.conversationType! } : null;
  return { queue: row.queue, agent, approved: Boolean(row.approved) };
}

/**
 * The queues an AI agent may transfer this conversation to (PM/research/11
 * §5.5): its queue's transfer targets whose agent answers (LIVE, with a
 * model) and is not the agent already holding the conversation (a transfer to
 * itself would leave the customer's messages unanswered). Only approved
 * targets: a target whose own approval is still open (or was rejected) is
 * never offered, even when the source queue's approval accepted it.
 */
export async function aiTransferTargets(tx: DbOrTx, sourceQueueId: string | null, currentAgentId: string | null = null): Promise<Array<{ queue: QueueRow; agentId: string; agentName: string }>> {
  if (!sourceQueueId) return [];
  const [source] = await tx.select({ targets: queues.transferTargetIds }).from(queues).where(eq(queues.id, sourceQueueId));
  if (!source?.targets.length) return [];
  const rows = await tx
    .select({ queue: queues, agentId: virtualAgents.id, agentName: virtualAgents.name })
    .from(queues)
    .innerJoin(virtualAgents, eq(virtualAgents.id, queues.agentId))
    .where(and(inArray(queues.id, source.targets), approvedQueue(), eq(virtualAgents.status, 'LIVE'), isNotNull(virtualAgents.modelProfileId), currentAgentId ? ne(virtualAgents.id, currentAgentId) : undefined));
  return rows.sort((a, b) => a.queue.name.localeCompare(b.queue.name));
}

export interface AiTransferInput {
  queueId: string;
  reason: string;
  summary: string;
  now: Date;
}

/**
 * An agent hands the conversation to another queue and its agent
 * (TRANSFER_QUEUE, AI_ACTIVE stays): the receiving agent gets a HANDOVER
 * summary and, because the transferring turn does not mark the customer's
 * messages answered, continues immediately. Caller owns the transaction and
 * publishes the turn.
 */
export async function aiTransferToQueue(tx: DbOrTx, actor: ActorContext, conversationId: string, input: AiTransferInput): Promise<{ agentId: string; queueName: string }> {
  const conv = await lockConversation(tx, conversationId);
  const allowed = await aiTransferTargets(tx, conv.queueId, conv.agentId);
  const target = allowed.find((t) => t.queue.id === input.queueId);
  if (!target) throw validation('transfer_target_not_allowed', 'This queue is not a transfer target of the conversation’s queue');
  const [fromAgent] = conv.agentId ? await tx.select({ name: virtualAgents.name, conversationType: virtualAgents.conversationType }).from(virtualAgents).where(eq(virtualAgents.id, conv.agentId)) : [];
  const [source] = conv.queueId ? await tx.select({ name: queues.name }).from(queues).where(eq(queues.id, conv.queueId)) : [];
  await moveToQueue(tx, actor, conv, target.queue, { id: target.agentId, name: target.agentName }, {
    command: 'AGENT',
    description: `transferred by ${fromAgent?.name ?? 'the agent'} to ${target.queue.name} (${target.agentName}) · ${input.reason}`,
    now: input.now,
  });
  await writeHandover(tx, conv, `Transferred to you from ${fromAgent?.name ?? 'another agent'}${source ? ` (${source.name})` : ''}. Reason: ${input.reason}\n${input.summary}`, null);
  return { agentId: target.agentId, queueName: target.queue.name };
}

/**
 * Move a conversation to a queue (and that queue's agent when it has one): the
 * shared part of AI and human transfers. SLA deadlines are recomputed for the
 * new queue; a transfer to a different agent is recorded as a routing event.
 */
export async function moveToQueue(
  tx: DbOrTx,
  actor: ActorContext,
  conv: ConversationRow,
  queue: QueueRow,
  agent: { id: string; name: string } | null,
  opts: { command: 'AGENT' | 'HUMAN'; description: string; now: Date; patch?: Parameters<typeof applyControl>[2]['patch'] },
): Promise<void> {
  const swap = agent && agent.id !== conv.agentId ? agent.id : null;
  const [agentType] = swap ? await tx.select({ t: virtualAgents.conversationType }).from(virtualAgents).where(eq(virtualAgents.id, swap)) : [];
  await applyControl(tx, conv.id, {
    command: 'TRANSFER_QUEUE',
    actor,
    transitionActor: opts.command,
    description: opts.description,
    patch: {
      ...opts.patch,
      queueId: queue.id,
      ...(swap ? { agentId: swap } : {}),
      resolutionDueAt: await resolutionDueFor(tx, queue, agentType?.t ?? conv.type, conv.openedAt),
    },
    now: opts.now,
  });
  if (swap) {
    // The conversation is now the receiving agent's kind (reporting, per-type SLAs), as routing sets it.
    if (agentType) await tx.update(conversations).set({ type: agentType.t }).where(eq(conversations.id, conv.id));
    await emitEvent(tx, actor, 'conversation.routed', { routerId: null, queueId: queue.id, agentId: swap, outcome: 'TRANSFER', ruleIndex: null }, { conversationId: conv.id, agentId: swap });
  }
}

/** A HANDOVER summary for whoever answers next (the receiving agent, or the agent after a human returns it). */
export async function writeHandover(tx: DbOrTx, conv: { id: string; lastSeq: number }, text: string, createdBy: string | null): Promise<void> {
  const [last] = await tx
    .select({ v: max(conversationSummaries.version) })
    .from(conversationSummaries)
    .where(and(eq(conversationSummaries.conversationId, conv.id), eq(conversationSummaries.kind, 'HANDOVER')));
  await tx.insert(conversationSummaries).values({ id: uuidv7(), conversationId: conv.id, version: (last?.v ?? 0) + 1, coversThroughSeq: conv.lastSeq, kind: 'HANDOVER', text: text.slice(0, 4_000), createdBy });
}
