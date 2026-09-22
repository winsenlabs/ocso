import { sql } from 'drizzle-orm';
import { outboxEvents, type DbOrTx } from '@ocso/db';
import { EPHEMERAL_EVENT_TYPES, createEvent, type OcsoEvent, type OcsoEventPayloads, type OcsoEventType } from '@ocso/events';
import type { ActorContext } from '../shared/context.js';

/** Postgres NOTIFY channel carrying realtime events to every API instance (ADR-009). */
export const EVENTS_CHANNEL = 'ocso_events';
/** NOTIFY payloads are limited to 8000 bytes; stay well below. */
const MAX_NOTIFY_BYTES = 7_000;

export interface EmitOptions {
  conversationId?: string | null | undefined;
  agentId?: string | null | undefined;
}

function notifyPayload(event: OcsoEvent): string {
  const full = JSON.stringify(event);
  if (Buffer.byteLength(full) <= MAX_NOTIFY_BYTES) return full;
  // Oversized payloads are fetched from the outbox by id.
  return JSON.stringify({ ...event, payload: null, truncated: true });
}

/**
 * Write a domain event to the transactional outbox and NOTIFY it. NOTIFY is
 * delivered on COMMIT, so subscribers never see events of rolled-back work.
 */
export async function emitEvent<T extends OcsoEventType>(
  tx: DbOrTx,
  actor: Pick<ActorContext, 'correlationId'>,
  type: T,
  payload: OcsoEventPayloads[T],
  options: EmitOptions = {},
): Promise<OcsoEvent<T>> {
  const event = createEvent(type, payload, {
    correlationId: actor.correlationId,
    conversationId: options.conversationId ?? undefined,
    agentId: options.agentId ?? undefined,
  });
  if (!EPHEMERAL_EVENT_TYPES.has(type)) {
    await tx.insert(outboxEvents).values({
      id: event.id,
      type: event.type,
      version: event.version,
      occurredAt: new Date(event.occurredAt),
      correlationId: event.correlationId,
      conversationId: options.conversationId ?? null,
      agentId: options.agentId ?? null,
      payload: event.payload as Record<string, unknown>,
    });
  }
  await tx.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${notifyPayload(event)})`);
  return event;
}

/** Ephemeral realtime-only event (stream deltas, status); never persisted. */
export async function publishEphemeral<T extends OcsoEventType>(
  db: DbOrTx,
  correlationId: string,
  type: T,
  payload: OcsoEventPayloads[T],
  options: EmitOptions = {},
): Promise<void> {
  const event = createEvent(type, payload, {
    correlationId,
    conversationId: options.conversationId ?? undefined,
    agentId: options.agentId ?? undefined,
  });
  await db.execute(sql`SELECT pg_notify(${EVENTS_CHANNEL}, ${notifyPayload(event)})`);
}
