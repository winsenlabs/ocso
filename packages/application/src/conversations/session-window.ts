import { and, eq, max } from 'drizzle-orm';
import { DomainError, ErrorCategory, sessionWindowState, type SessionWindowState } from '@ocso/domain';
import { channels, conversations, type DbOrTx } from '@ocso/db';

/**
 * Hours of free-form replies after the customer's last message for a
 * channel (the adapter's `sessionWindowHours`; WhatsApp 24), or null when the
 * channel has no window. Provided by the API/worker from the adapter registry.
 */
export type SessionWindowHours = (channel: { id: string; kind: string; name: string; settings: Record<string, unknown> }) => number | null;

/**
 * The customer's last message on this channel across their conversations:
 * WhatsApp's window belongs to the customer and the business number, not to
 * one OCSO conversation.
 */
export async function lastCustomerMessageAt(db: DbOrTx, customerId: string, channelId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(conversations.lastCustomerMessageAt) })
    .from(conversations)
    .where(and(eq(conversations.customerId, customerId), eq(conversations.channelId, channelId)));
  return row?.at ?? null;
}

/** Window state for a conversation's channel, or null (no channel / no window / no resolver). */
export async function conversationWindow(
  db: DbOrTx,
  conv: { customerId: string; channelId: string | null },
  hoursOf: SessionWindowHours | undefined,
  now: Date,
): Promise<SessionWindowState | null> {
  if (!conv.channelId || !hoursOf) return null;
  const [channel] = await db.select().from(channels).where(eq(channels.id, conv.channelId));
  if (!channel) return null;
  const hours = hoursOf(channel);
  if (hours === null) return null;
  return sessionWindowState(hours, await lastCustomerMessageAt(db, conv.customerId, conv.channelId), now);
}

/** 409 for a free-form reply after the window closed (checked before any provider call). */
export function sessionWindowClosed(state: SessionWindowState): DomainError {
  const when = state.closesAt ? ` at ${state.closesAt}` : '';
  return new DomainError(
    ErrorCategory.CONFLICT,
    'session_window_closed',
    `The 24-hour WhatsApp reply window closed${when}: the customer can only be reached with an approved template until they write again`,
    { closesAt: state.closesAt },
  );
}
