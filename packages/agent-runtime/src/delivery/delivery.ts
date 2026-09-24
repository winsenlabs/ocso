import { and, asc, desc, eq, isNotNull, lte } from 'drizzle-orm';
import { TemplateMessageDataSchema, isTemplateMessageSchema, type InteractionPart } from '@ocso/domain';
import { conversations, customerIdentities, interactionParts, interactions, turns, type Db } from '@ocso/db';
import { customerSafeParts, type ChannelAdapter, type ChannelRuntimeConfig, type OutboundMediaResolver, type OutboundTarget, type SendResult } from '@ocso/channels';
import type { BlobStore } from '@ocso/blob';
import { emitEvent, lastCustomerMessageAt } from '@ocso/application';
import type { ChannelRuntime } from './channel-runtime.js';

/** Outcome code stored on the interaction when the channel needs a template (same code as the API's 409). */
export const SESSION_WINDOW_CLOSED = 'session_window_closed';

export type DeliveryOutcome = { kind: 'sent' | 'skipped' } | { kind: 'retry'; reason: string } | { kind: 'failed'; reason: string };

/**
 * Outbound delivery (docs/07 §2, §5): only customer-safe parts reach the
 * adapter; the provider message id is recorded for delivery receipts.
 * A template message (one `ocso.message_template` part) goes through the
 * adapter's sendTemplate instead of render/send (docs/07 §3). The session
 * window is judged from the customer's last message on this channel across
 * conversations. At-least-once on crash between send and record (ADR-007).
 */
export class DeliveryService {
  constructor(
    private readonly db: Db,
    private readonly channels: ChannelRuntime,
    private readonly blobs: BlobStore,
  ) {}

  async deliver(interactionId: string, correlationId: string): Promise<DeliveryOutcome> {
    const [row] = await this.db.select().from(interactions).where(eq(interactions.id, interactionId));
    if (!row || row.visibility !== 'CUSTOMER' || row.direction !== 'OUTBOUND') return { kind: 'skipped' };
    if (row.externalMessageId || row.deliveryStatus === 'SENT' || row.deliveryStatus === 'DELIVERED' || row.deliveryStatus === 'READ') {
      return { kind: 'skipped' };
    }
    if (!row.channelId) return { kind: 'failed', reason: 'no channel' };
    const [conv] = await this.db.select().from(conversations).where(eq(conversations.id, row.conversationId));
    const partRows = await this.db.select().from(interactionParts).where(eq(interactionParts.interactionId, interactionId)).orderBy(asc(interactionParts.idx));
    const parts = partRows.map((p) => p.content as unknown as InteractionPart);
    const { adapter, config } = await this.channels.load(row.channelId);
    const capabilities = adapter.capabilities(config);
    const safe = customerSafeParts(parts, capabilities);
    if (!safe.parts.length) return this.markFailed(row.id, row.conversationId, 'no renderable parts', correlationId);

    const identities = await this.db
      .select()
      .from(customerIdentities)
      .where(and(eq(customerIdentities.customerId, conv!.customerId)))
      .orderBy(desc(customerIdentities.lastSeenAt));
    const identity = pickIdentity(identities, capabilities.identityKinds);
    if (!identity) return this.markFailed(row.id, row.conversationId, 'customer has no channel identity', correlationId);

    const media: OutboundMediaResolver = {
      signedUrl: (key, ttl) => this.blobs.signedGetUrl(key, ttl),
      read: async (key) => {
        const obj = await this.blobs.get(key);
        return { data: obj.data, mimeType: obj.contentType };
      },
    };
    const lastInboundAt = await lastCustomerMessageAt(this.db, conv!.customerId, row.channelId);
    const replyContext = await this.replyContextFor(row);
    const target: OutboundTarget = { identityKind: identity.kind, identityValue: identity.value, lastInboundAt, ...(replyContext ? { replyContext } : {}) };
    let lastId: string | null = null;
    for (const send of this.sends(adapter, config, safe.parts, target, media)) {
      const result = await send();
      if (!result.ok) {
        if (result.retriable) return { kind: 'retry', reason: result.errorCode };
        return this.markFailed(row.id, row.conversationId, result.requiresTemplate ? SESSION_WINDOW_CLOSED : result.errorCode, correlationId);
      }
      lastId = result.externalMessageId;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(interactions).set({ deliveryStatus: 'SENT', externalMessageId: lastId }).where(eq(interactions.id, row.id));
      await emitEvent(tx, { correlationId }, 'interaction.delivery_updated', { interactionId: row.id, status: 'SENT' }, { conversationId: row.conversationId });
    });
    return { kind: 'sent' };
  }

  /**
   * Where this message answers, as the adapter recorded it on the inbound message (a thread, a conversation
   * reference): the latest inbound message on the conversation and channel that carried one, up to the message
   * this reply answers — an agent reply's turn input (`turns.seq_to`), else the customer messages before this
   * one. A later message elsewhere (a DM answer while the customer @mentions the app in a channel) never moves a
   * reply there. Null when none did.
   */
  private async replyContextFor(row: { conversationId: string; channelId: string | null; seq: number; turnId: string | null }): Promise<Record<string, string> | null> {
    let upTo = row.seq;
    if (row.turnId) {
      const [turn] = await this.db.select({ seqTo: turns.seqTo }).from(turns).where(eq(turns.id, row.turnId));
      if (turn) upTo = Math.min(upTo, turn.seqTo);
    }
    const [latest] = await this.db
      .select({ replyContext: interactions.replyContext })
      .from(interactions)
      .where(
        and(
          eq(interactions.conversationId, row.conversationId),
          eq(interactions.channelId, row.channelId!),
          eq(interactions.direction, 'INBOUND'),
          isNotNull(interactions.replyContext),
          lte(interactions.seq, upTo),
        ),
      )
      .orderBy(desc(interactions.seq))
      .limit(1);
    return latest?.replyContext ?? null;
  }

  /** One provider call per rendered payload, or a single template send. */
  private sends(adapter: ChannelAdapter, config: ChannelRuntimeConfig, parts: InteractionPart[], target: OutboundTarget, media: OutboundMediaResolver): Array<() => Promise<SendResult>> {
    const templatePart = parts.find((p) => p.type === 'STRUCTURED' && isTemplateMessageSchema(p.schema));
    if (!templatePart || templatePart.type !== 'STRUCTURED') return adapter.render(parts, config).map((rendered) => () => adapter.send(target, rendered, config, media));
    const data = TemplateMessageDataSchema.safeParse(templatePart.data);
    const sendTemplate = adapter.sendTemplate?.bind(adapter);
    if (!data.success) return [() => Promise.resolve(failure('invalid_template_message', 'stored template message is malformed'))];
    if (!sendTemplate) return [() => Promise.resolve(failure('templates_unsupported', `${config.kind} channels cannot send templates`))];
    const { templateId, language, variables, headerMediaUrl, template } = data.data;
    return [() => sendTemplate(target, { templateId, language, variables, headerMediaUrl, template }, config, media)];
  }

  private async markFailed(interactionId: string, conversationId: string, reason: string, correlationId: string): Promise<DeliveryOutcome> {
    await this.db.transaction(async (tx) => {
      await tx.update(interactions).set({ deliveryStatus: 'FAILED', deliveryError: reason }).where(eq(interactions.id, interactionId));
      await emitEvent(tx, { correlationId }, 'interaction.delivery_updated', { interactionId, status: 'FAILED', errorCode: reason }, { conversationId });
    });
    return { kind: 'failed', reason };
  }
}

/** The identity the channel prefers (its declared order), else the most recently seen one. */
function pickIdentity<T extends { kind: string }>(byRecency: readonly T[], preferred: readonly string[] | undefined): T | undefined {
  for (const kind of preferred ?? []) {
    const match = byRecency.find((identity) => identity.kind === kind);
    if (match) return match;
  }
  return byRecency[0];
}

function failure(errorCode: string, message: string): SendResult {
  return { ok: false, errorCode, message, retriable: false };
}
