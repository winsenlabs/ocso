import { and, eq, sql } from 'drizzle-orm';
import { inboundStartsAiTurn, nextDeliveryStatus, type ControlState, type DeliveryStatus, type InteractionPart } from '@ocso/domain';
import { channels, conversations, interactions, virtualAgents, type Db } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import { relinkIdentity, resolveCustomer, type IdentityClaim } from '../customers/identity-resolver.js';
import { systemActor } from '../shared/context.js';
import { appendInteraction } from './interaction-writer.js';
import { admitConversation } from '../routing/routing-admit.js';

/** Channel-neutral inbound message (mirrors @ocso/channels InboundMessage). */
export interface IngressMessage {
  externalMessageId: string;
  identityKind: string;
  identityValue: string;
  alternateIdentities: readonly IdentityClaim[];
  profileName?: string | undefined;
  receivedAt: Date;
  parts: InteractionPart[];
}

export interface IngressStatusUpdate {
  externalMessageId: string;
  status: DeliveryStatus;
  errorCode?: string | undefined;
  errorTitle?: string | undefined;
}

export type IngressResult =
  | { status: 'accepted'; conversationId: string; interactionId: string; seq: number; created: boolean; turnQueued: boolean; routeQueued: boolean }
  | { status: 'duplicate'; conversationId: string; interactionId: string }
  | { status: 'rejected'; reason: 'channel_inactive' | 'no_router' };

export interface IngressOptions {
  /** A RESOLVED conversation is reopened if the customer writes within this window. */
  reopenWindowHours: number;
  now?: () => Date;
  /** Called when a message is rejected because the channel routes nowhere (log it loudly: customers are unanswered). */
  onRejected?: ((rejection: { channelId: string; reason: 'no_router'; detail: string }) => void) | undefined;
}

/**
 * Persist-before-process ingress (docs/04 §3–4, docs/07 §3). Every inbound
 * message is committed idempotently before any agent work is scheduled.
 */
export class IngressService {
  constructor(
    private readonly db: Db,
    private readonly queue: QueueAdapter,
    private readonly options: IngressOptions = { reopenWindowHours: 72 },
  ) {}

  async receive(channelId: string, message: IngressMessage, correlationId: string): Promise<IngressResult> {
    const now = this.options.now?.() ?? new Date();
    const outcome = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`ingress:${channelId}:${message.externalMessageId}`}))`);
      const [dup] = await tx
        .select({ id: interactions.id, conversationId: interactions.conversationId })
        .from(interactions)
        .where(and(eq(interactions.channelId, channelId), eq(interactions.idempotencyKey, message.externalMessageId)))
        .limit(1);
      if (dup) return { status: 'duplicate', conversationId: dup.conversationId, interactionId: dup.id } as const;

      const [channel] = await tx.select().from(channels).where(eq(channels.id, channelId));
      if (!channel || channel.status !== 'ACTIVE') return { status: 'rejected', reason: 'channel_inactive' } as const;

      const actor = systemActor(`channel:${channelId}`, correlationId, channel.name);
      const customer = await resolveCustomer(tx, {
        primary: { kind: message.identityKind, value: message.identityValue },
        alternates: message.alternateIdentities,
        profileName: message.profileName,
        now,
      });
      // channel → router → queue → agent (PM/research/11 §5.3).
      const admission = await admitConversation(tx, { channel, customerId: customer.customerId, now, correlationId, reopenWindowHours: this.options.reopenWindowHours });
      if (admission.status === 'rejected') {
        // Durable record (the exception report reads audit): who wrote, on which channel, and why nobody answers.
        // The message text is not kept here: audit readers are not conversation readers.
        await recordAudit(tx, actor, {
          action: 'conversation.inbound_rejected',
          targetType: 'channel',
          targetId: channelId,
          summary: `Customer message on ${channel.name} not accepted (${admission.reason}): ${admission.detail}`,
          after: { reason: admission.reason, detail: admission.detail, customerId: customer.customerId, externalMessageId: message.externalMessageId, receivedAt: message.receivedAt.toISOString() },
        });
        this.options.onRejected?.({ channelId, reason: admission.reason, detail: admission.detail });
        return { status: 'rejected', reason: admission.reason } as const;
      }
      const { conversationId, created } = admission;
      const appended = await appendInteraction(
        tx,
        conversationId,
        {
          actorType: 'CUSTOMER',
          actorId: customer.customerId,
          direction: 'INBOUND',
          visibility: 'CUSTOMER',
          idempotencyKey: message.externalMessageId,
          correlationId,
          parts: message.parts,
        },
        { channelId, now },
      );
      await tx.update(channels).set({ lastInboundAt: now }).where(eq(channels.id, channelId));
      await emitEvent(tx, actor, 'interaction.received', { interactionId: appended.interactionId, seq: appended.seq, actorType: 'CUSTOMER', channelId }, {
        conversationId,
        agentId: admission.agentId,
      });
      const [state] = await tx.select({ controlState: conversations.controlState }).from(conversations).where(eq(conversations.id, conversationId));
      const [agent] = admission.agentId ? await tx.select({ status: virtualAgents.status, copilotEnabled: virtualAgents.copilotEnabled }).from(virtualAgents).where(eq(virtualAgents.id, admission.agentId)) : [];
      const route = admission.route || state!.controlState === 'ROUTING';
      const runTurn = !route && agent?.status === 'LIVE' && inboundStartsAiTurn(state!.controlState as ControlState);
      // A human holds the conversation: prepare a copilot draft for them (never sent automatically).
      const suggest = Boolean(agent?.copilotEnabled) && state!.controlState === 'HUMAN_ACTIVE';
      return { status: 'accepted', conversationId, interactionId: appended.interactionId, seq: appended.seq, created, runTurn, suggest, route } as const;
    });

    if (outcome.status !== 'accepted') return outcome;
    // After commit: schedule work. If publishing fails, the turn sweeper re-enqueues (docs/10 §9).
    const mediaParts = message.parts.flatMap((p, idx) => ('media' in p && p.media.status === 'PENDING' ? [idx] : []));
    await Promise.allSettled([
      ...mediaParts.map((partIdx) =>
        this.queue.publish('media.fetch', { conversationId: outcome.conversationId, interactionId: outcome.interactionId, partIdx }, {
          dedupeKey: `media:${outcome.interactionId}:${partIdx}`,
        }),
      ),
      outcome.runTurn
        ? this.queue.publish('conversation.turn', { conversationId: outcome.conversationId, seq: outcome.seq }, {
            groupKey: outcome.conversationId,
            dedupeKey: `turn:${outcome.conversationId}:${outcome.seq}`,
          })
        : Promise.resolve(),
      outcome.route
        ? this.queue.publish('conversation.route', { conversationId: outcome.conversationId }, {
            groupKey: outcome.conversationId,
            dedupeKey: `route:${outcome.conversationId}:${outcome.seq}`,
          })
        : Promise.resolve(),
      outcome.suggest
        ? this.queue.publish('copilot.suggest', { conversationId: outcome.conversationId, seq: outcome.seq }, {
            groupKey: outcome.conversationId,
            dedupeKey: `copilot:${outcome.conversationId}:${outcome.seq}`,
          })
        : Promise.resolve(),
    ]);
    const { runTurn, suggest: _suggest, route, ...rest } = outcome;
    return { ...rest, turnQueued: runTurn, routeQueued: route };
  }

  /** Delivery receipts: monotonic status updates by provider message id. */
  async receiveStatuses(channelId: string, updates: readonly IngressStatusUpdate[], correlationId: string): Promise<number> {
    let applied = 0;
    for (const update of updates) {
      await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select({ id: interactions.id, conversationId: interactions.conversationId, deliveryStatus: interactions.deliveryStatus })
          .from(interactions)
          .where(and(eq(interactions.channelId, channelId), eq(interactions.externalMessageId, update.externalMessageId)))
          .for('update')
          .limit(1);
        if (!row) return;
        const next = nextDeliveryStatus(row.deliveryStatus as DeliveryStatus, update.status);
        if (next === row.deliveryStatus) return;
        await tx
          .update(interactions)
          .set({ deliveryStatus: next, deliveryError: update.errorCode ? `${update.errorCode} ${update.errorTitle ?? ''}`.trim() : null })
          .where(eq(interactions.id, row.id));
        await emitEvent(tx, { correlationId }, 'interaction.delivery_updated', { interactionId: row.id, status: next, ...(update.errorCode ? { errorCode: update.errorCode } : {}) }, {
          conversationId: row.conversationId,
        });
        applied++;
      });
    }
    return applied;
  }

  async applyIdentityUpdate(kind: string, previousValue: string, currentValue: string): Promise<boolean> {
    return this.db.transaction((tx) => relinkIdentity(tx, kind, previousValue, currentValue));
  }
}
