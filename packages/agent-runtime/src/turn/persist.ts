import { eq } from 'drizzle-orm';
import { DomainError, aiMaySendAutonomously, type ControlState } from '@ocso/domain';
import { contextSnapshots, conversations, turns, type Db } from '@ocso/db';
import { appendInteraction, emitEvent, lockConversation, requestHandoff, agentActor } from '@ocso/application';
import type { QueueAdapter } from '@ocso/queue';
import type { LeaseManager } from '../leases/lease-manager.js';
import type { TurnContext } from '../context/context-builder.js';

/** A human took control mid-turn; the AI must not send (docs/04 §6). */
export class TurnSupersededError extends DomainError {
  constructor() {
    super('conflict', 'turn_superseded', 'A human took over the conversation during the turn');
  }
}

export interface TurnIdentity {
  conversationId: string;
  turnId: string;
  agentId: string;
  agentName: string;
  channelId: string | null;
  leaseVersion: number;
  correlationId: string;
}

/**
 * Customer-visible writes go through here: fencing (lease version) and a fresh
 * control-state check in the same transaction, so a stale worker or a human
 * takeover can never produce an AI reply.
 */
export class TurnWriter {
  private messageIndex = 0;

  constructor(
    private readonly db: Db,
    private readonly leases: LeaseManager,
    private readonly queue: QueueAdapter,
  ) {}

  async agentMessage(t: TurnIdentity, text: string): Promise<string> {
    const index = this.messageIndex++;
    const interactionId = await this.db.transaction(async (tx) => {
      await this.leases.assertHeld(tx, t.conversationId, t.leaseVersion);
      const conv = await lockConversation(tx, t.conversationId);
      if (!aiMaySendAutonomously(conv.controlState as ControlState)) throw new TurnSupersededError();
      const appended = await appendInteraction(
        tx,
        t.conversationId,
        {
          actorType: 'AGENT',
          actorId: t.agentId,
          direction: 'OUTBOUND',
          visibility: 'CUSTOMER',
          idempotencyKey: `agent:${t.turnId}:${index}`,
          correlationId: t.correlationId,
          parts: [{ type: 'TEXT', text }],
        },
        { channelId: t.channelId, turnId: t.turnId, deliveryStatus: 'PENDING', now: new Date() },
      );
      await emitEvent(tx, { correlationId: t.correlationId }, 'interaction.sent', { interactionId: appended.interactionId, seq: appended.seq, actorType: 'AGENT' }, {
        conversationId: t.conversationId,
        agentId: t.agentId,
      });
      return appended.interactionId;
    });
    await this.queue.publish('channel.deliver', { interactionId }, { groupKey: t.conversationId, dedupeKey: `deliver:${interactionId}` });
    return interactionId;
  }

  async complete(
    t: TurnIdentity,
    ctx: TurnContext,
    outcome: { kind: 'REPLIED' | 'HANDOFF' | 'NO_REPLY' | 'AWAITING_CONFIRMATION'; steps: number; latencyMs: number; ttftMs: number | null; providerId: string | null; model: string | null },
    handoff: { reason: string; summary: string; priority?: 'P1' | 'P2' | 'P3' | 'P4' | undefined; trigger: 'AGENT_DECISION' | 'CUSTOMER_REQUEST' | 'SENSITIVE_ACTION' | 'TOOL_FAILURE' } | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.leases.assertHeld(tx, t.conversationId, t.leaseVersion);
      const conv = await lockConversation(tx, t.conversationId);
      await tx
        .update(conversations)
        .set({ lastProcessedSeq: Math.max(conv.lastProcessedSeq, ctx.pendingSeqTo) })
        .where(eq(conversations.id, t.conversationId));
      if (handoff && aiMaySendAutonomously(conv.controlState as ControlState)) {
        await requestHandoff(
          tx,
          agentActor(t.agentId, t.correlationId, t.agentName),
          t.conversationId,
          {
            trigger: handoff.trigger,
            reasonCode: handoff.trigger.toLowerCase(),
            reasonText: handoff.reason,
            agentSummary: handoff.summary,
            priority: handoff.priority,
            requestedBy: { type: 'AGENT', id: t.agentId },
          },
          new Date(),
        );
      }
      await tx
        .update(turns)
        .set({
          status: 'COMPLETED',
          outcome: outcome.kind,
          steps: outcome.steps,
          latencyMs: outcome.latencyMs,
          ttftMs: outcome.ttftMs,
          providerId: outcome.providerId,
          model: outcome.model,
          cacheLayer: ctx.cacheLayer,
          contextHashes: { ...ctx.compiled.hashes.components, agentPrefixHash: ctx.compiled.hashes.agentPrefixHash, conversationContextHash: ctx.compiled.hashes.conversationContextHash, toolSchemaHash: ctx.compiled.hashes.toolSchemaHash },
          completedAt: new Date(),
        })
        .where(eq(turns.id, t.turnId));
      await tx
        .insert(contextSnapshots)
        .values({
          conversationId: t.conversationId,
          hashes: { agentPrefixHash: ctx.compiled.hashes.agentPrefixHash, conversationContextHash: ctx.compiled.hashes.conversationContextHash, toolSchemaHash: ctx.compiled.hashes.toolSchemaHash, fullHash: ctx.compiled.hashes.fullHash },
          generations: {},
          snapshot: { turnId: t.turnId, processedThroughSeq: ctx.pendingSeqTo, tokenEstimate: ctx.compiled.tokenEstimate, cacheLayer: ctx.cacheLayer },
        })
        .onConflictDoUpdate({
          target: contextSnapshots.conversationId,
          set: {
            hashes: { agentPrefixHash: ctx.compiled.hashes.agentPrefixHash, conversationContextHash: ctx.compiled.hashes.conversationContextHash, toolSchemaHash: ctx.compiled.hashes.toolSchemaHash, fullHash: ctx.compiled.hashes.fullHash },
            snapshot: { turnId: t.turnId, processedThroughSeq: ctx.pendingSeqTo, tokenEstimate: ctx.compiled.tokenEstimate, cacheLayer: ctx.cacheLayer },
            updatedAt: new Date(),
          },
        });
      await emitEvent(tx, { correlationId: t.correlationId }, 'agent.turn_completed', { turnId: t.turnId, outcome: outcome.kind === 'AWAITING_CONFIRMATION' ? 'HANDOFF' : outcome.kind }, {
        conversationId: t.conversationId,
        agentId: t.agentId,
      });
    });
  }

  /** Route to humans when the model is persistently unavailable (no customer is left waiting). */
  async outageHandoff(t: TurnIdentity, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.leases.assertHeld(tx, t.conversationId, t.leaseVersion);
      const conv = await lockConversation(tx, t.conversationId);
      if (!aiMaySendAutonomously(conv.controlState as ControlState)) return;
      await requestHandoff(
        tx,
        agentActor(t.agentId, t.correlationId, t.agentName),
        t.conversationId,
        { trigger: 'POLICY', reasonCode: 'ai_unavailable', reasonText: reason, priority: 'P2', requestedBy: { type: 'SYSTEM', id: 'runtime' } },
        new Date(),
      );
    });
  }

  async fail(t: TurnIdentity, status: 'FAILED' | 'CANCELLED' | 'SUPERSEDED', error: { category: string; message: string } | null): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .update(turns)
        .set({ status, outcome: status === 'FAILED' ? 'FAILED' : 'CANCELLED', errorCategory: error?.category ?? null, errorMessage: error?.message?.slice(0, 500) ?? null, completedAt: new Date() })
        .where(eq(turns.id, t.turnId));
      await emitEvent(tx, { correlationId: t.correlationId }, 'agent.turn_completed', { turnId: t.turnId, outcome: status === 'FAILED' ? 'FAILED' : 'CANCELLED' }, {
        conversationId: t.conversationId,
        agentId: t.agentId,
      });
    });
  }
}
