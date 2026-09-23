import { eq, sql } from 'drizzle-orm';
import {
  ControlState,
  notFound,
  transition,
  type ControlCommand,
  type TransitionActor,
} from '@ocso/domain';
import { conversations, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { appendSystemEvent } from './interaction-writer.js';

export type ConversationRow = typeof conversations.$inferSelect;

/** Extra column changes that accompany a control transition. */
export type ControlPatch = Partial<
  Pick<
    ConversationRow,
    | 'assignedUserId'
    | 'queueId'
    | 'priority'
    | 'waitingSince'
    | 'slaDueAt'
    | 'resolutionDueAt'
    | 'resolvedAt'
    | 'resolvedBy'
    | 'disposition'
    | 'firstHumanResponseAt'
  >
>;

export interface ControlChange {
  command: ControlCommand;
  actor: ActorContext;
  transitionActor: TransitionActor;
  /** Human-readable timeline text, e.g. "claimed by Nikhil Menon". */
  description: string;
  patch?: ControlPatch | undefined;
  reopenedBy?: 'CUSTOMER' | 'HUMAN' | undefined;
  now: Date;
}

export interface ControlResult {
  from: ControlState;
  to: ControlState;
  conversation: ConversationRow;
}

/** Load a conversation row with FOR UPDATE (serializes concurrent control changes). */
export async function lockConversation(tx: DbOrTx, conversationId: string): Promise<ConversationRow> {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).for('update');
  if (!row) throw notFound('conversation', conversationId);
  return row;
}

/**
 * The single write path for control-state changes (ADR-005): validates the
 * transition, applies it with a version bump, writes an internal timeline
 * event, an audit record and a `conversation.control_changed` event — all in
 * the caller's transaction.
 */
export async function applyControl(tx: DbOrTx, conversationId: string, change: ControlChange): Promise<ControlResult> {
  const current = await lockConversation(tx, conversationId);
  const from = current.controlState as ControlState;
  const to = transition(from, change.command, {
    actor: change.transitionActor,
    actorUserId: change.actor.principal?.userId,
    assignedUserId: current.assignedUserId,
    reopenedBy: change.reopenedBy,
  });
  const [updated] = await tx
    .update(conversations)
    .set({
      ...change.patch,
      controlState: to,
      version: sql`${conversations.version} + 1`,
      updatedAt: change.now,
      ...(change.command === 'REOPEN' ? { resolvedAt: null, reopenCount: sql`${conversations.reopenCount} + 1` } : {}),
    })
    .where(eq(conversations.id, conversationId))
    .returning();
  await appendSystemEvent(
    tx,
    conversationId,
    'system.control_changed',
    `${change.description} · control ${to}`,
    { from, to, command: change.command, actorType: change.transitionActor, actorId: change.actor.principal?.userId ?? change.actor.system?.id ?? null },
    change.actor.correlationId,
    change.now,
  );
  await recordAudit(tx, change.actor, {
    action: `conversation.${change.command.toLowerCase()}`,
    targetType: 'conversation',
    targetId: conversationId,
    summary: `${change.description} (${from} → ${to})`,
    before: { controlState: from, assignedUserId: current.assignedUserId, queueId: current.queueId },
    after: { controlState: to, ...change.patch },
  });
  await emitEvent(
    tx,
    change.actor,
    'conversation.control_changed',
    {
      from,
      to,
      command: change.command,
      actorType: change.transitionActor,
      actorId: change.actor.principal?.userId ?? change.actor.system?.id ?? null,
    },
    { conversationId, agentId: current.agentId },
  );
  return { from, to, conversation: updated! };
}
