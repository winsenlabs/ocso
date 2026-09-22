import { and, desc, eq, gt, ne, sql } from 'drizzle-orm';
import { inboundStartsAiTurn, nextDeliveryStatus, type ControlState, type DeliveryStatus, type InteractionPart } from '@ocso/domain';
import { channels, conversations, interactions, virtualAgents, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import type { QueueAdapter } from '@ocso/queue';
import { emitEvent } from '../events/outbox.js';
import { relinkIdentity, resolveCustomer, type IdentityClaim } from '../customers/identity-resolver.js';
import { systemActor } from '../shared/context.js';
import { applyControl } from './control.js';
import { appendInteraction } from './interaction-writer.js';

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
  | { status: 'accepted'; conversationId: string; interactionId: string; seq: number; created: boolean; turnQueued: boolean }
  | { status: 'duplicate'; conversationId: string; interactionId: string }
  | { status: 'rejected'; reason: 'channel_inactive' | 'no_agent' };

export interface IngressOptions {
  /** A RESOLVED conversation is reopened if the customer writes within this window. */
  reopenWindowHours: number;
  now?: () => Date;
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
      if (!channel.defaultAgentId) return { status: 'rejected', reason: 'no_agent' } as const;
      const [agent] = await tx.select().from(virtualAgents).where(eq(virtualAgents.id, channel.defaultAgentId));
      if (!agent) return { status: 'rejected', reason: 'no_agent' } as const;

      const actor = systemActor(`channel:${channelId}`, correlationId, channel.name);
      const customer = await resolveCustomer(tx, {
        primary: { kind: message.identityKind, value: message.identityValue },
        alternates: message.alternateIdentities,
        profileName: message.profileName,
        now,
      });
      const { conversationId, created } = await this.openConversation(tx, {
        customerId: customer.customerId,
        channelId,
        agent,
        now,
        correlationId,
      });
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
      if (created) {
        await emitEvent(tx, actor, 'conversation.created', { customerId: customer.customerId, channelId, queueId: agent.defaultQueueId }, {
          conversationId,
          agentId: agent.id,
        });
      }
      await emitEvent(tx, actor, 'interaction.received', { interactionId: appended.interactionId, seq: appended.seq, actorType: 'CUSTOMER', channelId }, {
        conversationId,
        agentId: agent.id,
      });
      const [state] = await tx.select({ controlState: conversations.controlState }).from(conversations).where(eq(conversations.id, conversationId));
      const runTurn = agent.status === 'LIVE' && inboundStartsAiTurn(state!.controlState as ControlState);
      return { status: 'accepted', conversationId, interactionId: appended.interactionId, seq: appended.seq, created, runTurn } as const;
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
    ]);
    const { runTurn, ...rest } = outcome;
    return { ...rest, turnQueued: runTurn };
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

  private async openConversation(
    tx: DbOrTx,
    input: { customerId: string; channelId: string; agent: typeof virtualAgents.$inferSelect; now: Date; correlationId: string },
  ): Promise<{ conversationId: string; created: boolean }> {
    const scope = and(eq(conversations.customerId, input.customerId), eq(conversations.channelId, input.channelId), eq(conversations.agentId, input.agent.id));
    const [open] = await tx.select({ id: conversations.id }).from(conversations).where(and(scope, ne(conversations.controlState, 'RESOLVED'))).limit(1);
    if (open) return { conversationId: open.id, created: false };

    const windowStart = new Date(input.now.getTime() - this.options.reopenWindowHours * 3_600_000);
    const [recent] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(scope, eq(conversations.controlState, 'RESOLVED'), gt(conversations.resolvedAt, windowStart)))
      .orderBy(desc(conversations.resolvedAt))
      .limit(1);
    if (recent) {
      await applyControl(tx, recent.id, {
        command: 'REOPEN',
        actor: systemActor('ingress', input.correlationId),
        transitionActor: 'CUSTOMER',
        reopenedBy: 'CUSTOMER',
        description: 'customer wrote again · conversation reopened',
        now: input.now,
      });
      return { conversationId: recent.id, created: false };
    }

    const id = uuidv7();
    await tx.insert(conversations).values({
      id,
      customerId: input.customerId,
      agentId: input.agent.id,
      channelId: input.channelId,
      type: input.agent.conversationType,
      controlState: 'AI_ACTIVE',
      queueId: input.agent.defaultQueueId,
      openedAt: input.now,
      lastInteractionAt: input.now,
    });
    return { conversationId: id, created: true };
  }
}
