import { eq, sql } from 'drizzle-orm';
import { partToPlainText, type InteractionPart, type NewInteraction } from '@ocso/domain';
import { conversations, interactionParts, interactions, uuidv7, type DbOrTx } from '@ocso/db';

export interface AppendResult {
  interactionId: string;
  seq: number;
}

export interface AppendOptions {
  channelId: string | null;
  turnId?: string | null | undefined;
  kind?: 'MESSAGE' | 'SYSTEM_EVENT' | 'TOOL_EVENT' | undefined;
  deliveryStatus?: string | undefined;
  now: Date;
}

const PREVIEW_MAX = 280;

export function previewOf(parts: readonly InteractionPart[]): string {
  return parts
    .map(partToPlainText)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PREVIEW_MAX);
}

/**
 * Append an interaction with its parts. The conversation row is locked by the
 * seq increment, so seq is gap-free and totally ordered per conversation.
 * Must run inside a transaction.
 */
export async function appendInteraction(
  tx: DbOrTx,
  conversationId: string,
  input: NewInteraction,
  options: AppendOptions,
): Promise<AppendResult> {
  const isCustomerMessage = input.actorType === 'CUSTOMER' && (options.kind ?? 'MESSAGE') === 'MESSAGE';
  const visibleMessage = input.visibility === 'CUSTOMER' && (options.kind ?? 'MESSAGE') === 'MESSAGE';
  const preview = previewOf(input.parts);
  const [row] = await tx
    .update(conversations)
    .set({
      lastSeq: sql`${conversations.lastSeq} + 1`,
      lastInteractionAt: options.now,
      updatedAt: options.now,
      ...(visibleMessage ? { lastPreview: preview } : {}),
      ...(isCustomerMessage ? { lastCustomerMessageAt: options.now } : {}),
    })
    .where(eq(conversations.id, conversationId))
    .returning({ seq: conversations.lastSeq });
  if (!row) throw new Error(`conversation ${conversationId} not found`);

  const interactionId = uuidv7();
  await tx.insert(interactions).values({
    id: interactionId,
    conversationId,
    channelId: options.channelId,
    seq: row.seq,
    actorType: input.actorType,
    actorId: input.actorId,
    direction: input.direction,
    visibility: input.visibility,
    kind: options.kind ?? 'MESSAGE',
    correlationId: input.correlationId ?? interactionId,
    idempotencyKey: input.idempotencyKey,
    deliveryStatus: options.deliveryStatus ?? 'NOT_APPLICABLE',
    turnId: options.turnId ?? null,
    preview,
    createdAt: options.now,
  });
  await tx.insert(interactionParts).values(
    input.parts.map((part, idx) => ({
      id: uuidv7(),
      interactionId,
      idx,
      type: part.type,
      content: part as unknown as Record<string, unknown>,
      blobKey: 'media' in part ? (part.media.blobKey ?? null) : null,
      mediaStatus: 'media' in part ? part.media.status : null,
    })),
  );
  return { interactionId, seq: row.seq };
}

/** Internal timeline marker (control changes, routing) — never customer-visible. */
export async function appendSystemEvent(
  tx: DbOrTx,
  conversationId: string,
  schema: string,
  text: string,
  data: Record<string, unknown>,
  correlationId: string,
  now: Date,
): Promise<AppendResult> {
  return appendInteraction(
    tx,
    conversationId,
    {
      actorType: 'SYSTEM',
      actorId: null,
      direction: 'INTERNAL',
      visibility: 'INTERNAL',
      idempotencyKey: null,
      correlationId,
      parts: [{ type: 'STRUCTURED', schema, data, fallbackText: text }],
    },
    { channelId: null, kind: 'SYSTEM_EVENT', now },
  );
}
