import { eq } from 'drizzle-orm';
import { displayId } from '@ocso/domain';
import { channels, conversations, customers, type DbOrTx } from '@ocso/db';

export interface WebhookEnvelope {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  correlationId: string;
  agentId: string | null;
  /** Minimal conversation reference for conversation-scoped events; no content. */
  conversation: { id: string; displayId: string; controlState: string; channelKind: string | null; customerRef: string | null } | null;
  data: unknown;
}

export async function conversationRef(db: DbOrTx, conversationId: string | null): Promise<WebhookEnvelope['conversation']> {
  if (!conversationId) return null;
  const [row] = await db
    .select({ id: conversations.id, controlState: conversations.controlState, channelKind: channels.kind, customerRef: customers.externalRef })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .leftJoin(channels, eq(channels.id, conversations.channelId))
    .where(eq(conversations.id, conversationId));
  return row ? { ...row, displayId: displayId('conv', row.id) } : null;
}
