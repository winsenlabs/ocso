import { eq, sql } from 'drizzle-orm';
import { Permission, assertCan, can } from '@ocso/auth';
import { InteractionPart, validation } from '@ocso/domain';
import { conversations, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { z } from 'zod';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { lockConversation } from '../conversations/control.js';
import { appendInteraction } from '../conversations/interaction-writer.js';
import { conversationWindow, sessionWindowClosed, type SessionWindowHours } from '../conversations/session-window.js';
import { verifyStaffMedia, type StoredMediaLookup } from './staff-attachments.js';

export const HumanReplyInput = z.object({
  parts: z.array(InteractionPart).min(1).max(10),
  /** Client-generated key so a double-click never sends twice. */
  clientMessageId: z.string().min(8).max(100),
});
export type HumanReplyInput = z.infer<typeof HumanReplyInput>;

/**
 * A human reply to the customer (docs/09 §6 CS Exec "customer reply"). Allowed
 * only while HUMAN_ACTIVE and only for the handling human (or a lead). On
 * channels with a customer-service window (WhatsApp) a free-form reply after
 * the window closed is refused with 409 `session_window_closed` before
 * anything reaches the provider — send an approved template instead
 * (template-message.ts). Delivery happens asynchronously through the adapter.
 */
export async function sendHumanReply(
  db: Db,
  queue: QueueAdapter,
  actor: ActorContext,
  conversationId: string,
  input: HumanReplyInput,
  options: { media?: StoredMediaLookup | undefined; windowHours?: SessionWindowHours | undefined; now?: (() => Date) | undefined } = {},
): Promise<{ interactionId: string; seq: number; duplicate: boolean }> {
  const p = actor.principal!;
  assertCan(p, Permission.CONVERSATIONS_REPLY);
  if (input.parts.some((part) => part.type === 'TOOL_RESULT')) throw validation('invalid_part', 'Tool results cannot be sent to customers');
  const parts = await verifyStaffMedia(input.parts, conversationId, options.media);
  const result = await db.transaction(async (tx) => {
    const conv = await lockConversation(tx, conversationId);
    if (conv.controlState !== 'HUMAN_ACTIVE') throw validation('not_human_active', 'Take over or claim the conversation before replying');
    if (conv.assignedUserId !== p.userId && !can(p, Permission.CONVERSATIONS_ASSIGN)) {
      throw validation('not_handler', 'Only the human handling this conversation can reply');
    }
    const existing = await tx.execute<{ id: string; seq: number }>(
      sql`SELECT id, seq FROM interactions WHERE conversation_id = ${conversationId} AND idempotency_key = ${`human:${input.clientMessageId}`}`,
    );
    if (existing.rows[0]) return { interactionId: existing.rows[0].id, seq: existing.rows[0].seq, duplicate: true };
    const now = options.now?.() ?? new Date();
    const window = await conversationWindow(tx, conv, options.windowHours, now);
    if (window && !window.open) throw sessionWindowClosed(window);
    const appended = await appendInteraction(
      tx,
      conversationId,
      {
        actorType: 'HUMAN',
        actorId: p.userId,
        direction: 'OUTBOUND',
        visibility: 'CUSTOMER',
        idempotencyKey: `human:${input.clientMessageId}`,
        correlationId: actor.correlationId,
        parts,
      },
      { channelId: conv.channelId, deliveryStatus: 'PENDING', now },
    );
    await tx
      .update(conversations)
      .set({
        // The human answered everything received so far.
        lastProcessedSeq: appended.seq,
        ...(conv.firstHumanResponseAt ? {} : { firstHumanResponseAt: now }),
      })
      .where(eq(conversations.id, conversationId));
    await emitEvent(tx, actor, 'human.message_sent', { interactionId: appended.interactionId, userId: p.userId }, { conversationId, agentId: conv.agentId });
    return { ...appended, duplicate: false };
  });
  if (!result.duplicate) {
    await queue.publish('channel.deliver', { interactionId: result.interactionId }, { groupKey: conversationId, dedupeKey: `deliver:${result.interactionId}` });
  }
  return result;
}
