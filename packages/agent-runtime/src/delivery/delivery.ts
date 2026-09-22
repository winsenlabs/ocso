import { and, asc, desc, eq } from 'drizzle-orm';
import type { InteractionPart } from '@ocso/domain';
import { conversations, customerIdentities, interactionParts, interactions, type Db } from '@ocso/db';
import { customerSafeParts, type OutboundMediaResolver } from '@ocso/channels';
import type { BlobStore } from '@ocso/blob';
import { emitEvent } from '@ocso/application';
import type { ChannelRuntime } from './channel-runtime.js';

export type DeliveryOutcome = { kind: 'sent' | 'skipped' } | { kind: 'retry'; reason: string } | { kind: 'failed'; reason: string };

/**
 * Outbound delivery (docs/07 §2, §5): only customer-safe parts reach the
 * adapter; the provider message id is recorded for delivery receipts.
 * At-least-once on crash between send and record (ADR-007).
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
    const target = { identityKind: identity.kind, identityValue: identity.value, lastInboundAt: conv!.lastCustomerMessageAt };
    let lastId: string | null = null;
    for (const rendered of adapter.render(safe.parts, config)) {
      const result = await adapter.send(target, rendered, config, media);
      if (!result.ok) {
        if (result.retriable) return { kind: 'retry', reason: result.errorCode };
        return this.markFailed(row.id, row.conversationId, result.requiresTemplate ? 'outside_session_window' : result.errorCode, correlationId);
      }
      lastId = result.externalMessageId;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(interactions).set({ deliveryStatus: 'SENT', externalMessageId: lastId }).where(eq(interactions.id, row.id));
      await emitEvent(tx, { correlationId }, 'interaction.delivery_updated', { interactionId: row.id, status: 'SENT' }, { conversationId: row.conversationId });
    });
    return { kind: 'sent' };
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
