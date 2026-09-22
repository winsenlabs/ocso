import { and, desc, eq, isNull, max, sql } from 'drizzle-orm';
import { Permission, assertCan, can } from '@ocso/auth';
import { forbidden, validation } from '@ocso/domain';
import { assignments, conversationSummaries, conversations, handoffs, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';
import { applyControl, lockConversation } from '../conversations/control.js';
import { endOpenAssignment } from './routing.js';
import { offerToNextExec, openHandoff } from './request.js';

export const ReturnToAiInput = z.object({
  handoverSummary: z.string().trim().min(1).max(4_000),
});
export const ResolveInput = z.object({ disposition: z.string().trim().max(200).optional() });
export const TransferInput = z.object({ queueId: z.uuid().optional(), userId: z.uuid().optional() }).refine((v) => v.queueId || v.userId, 'queueId or userId required');

const nameOf = (actor: ActorContext) => actor.principal?.displayName ?? 'system';

/**
 * Human operations on a conversation (docs/09 §4, build rule §7). Every method
 * is one transaction: control transition + handoff/assignment records +
 * timeline + audit + events.
 */
export class HumanControlService {
  constructor(private readonly db: Db, private readonly now: () => Date = () => new Date()) {}

  /** Open pickup: first eligible human wins; racing claims → exactly one succeeds. */
  async claim(actor: ActorContext, conversationId: string): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_CLAIM);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      await applyControl(tx, conversationId, {
        command: 'CLAIM',
        actor,
        transitionActor: 'HUMAN',
        description: `claimed by ${nameOf(actor)}`,
        patch: { assignedUserId: actor.principal!.userId, waitingSince: null },
        now,
      });
      await this.activateHandoff(tx, actor, conversationId, 'CLAIM', now);
    });
  }

  /** Auto-assign: the offered exec accepts. */
  async accept(actor: ActorContext, conversationId: string): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_CLAIM);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      await applyControl(tx, conversationId, {
        command: 'ACCEPT_ASSIGNMENT',
        actor,
        transitionActor: 'HUMAN',
        description: `assignment accepted by ${nameOf(actor)}`,
        patch: { waitingSince: null },
        now,
      });
      await tx
        .update(assignments)
        .set({ acceptedAt: now })
        .where(and(eq(assignments.conversationId, conversationId), eq(assignments.userId, actor.principal!.userId), isNull(assignments.endedAt)));
      await this.activateHandoff(tx, actor, conversationId, null, now);
    });
  }

  /** The offered exec declines (or the offer times out); re-offer to someone else. */
  async decline(actor: ActorContext, conversationId: string, reason = 'declined'): Promise<void> {
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const conv = await lockConversation(tx, conversationId);
      const handoff = await openHandoff(tx, conversationId);
      const declined = conv.assignedUserId;
      if (!handoff || !declined || conv.controlState !== 'WAITING_FOR_HUMAN') return;
      if (actor.principal && actor.principal.userId !== declined && !can(actor.principal, Permission.CONVERSATIONS_ASSIGN)) {
        throw forbidden('conversations.decline', 'only the offered user can decline');
      }
      await endOpenAssignment(tx, conversationId, reason, now);
      await tx.update(conversations).set({ assignedUserId: null, updatedAt: now }).where(eq(conversations.id, conversationId));
      const exclude = [...handoff.declinedUserIds, declined];
      await tx.update(handoffs).set({ status: 'WAITING', assignedUserId: null, declinedUserIds: exclude }).where(eq(handoffs.id, handoff.id));
      await emitEvent(tx, actor, 'assignment.changed', { userId: null, previousUserId: declined, kind: reason }, { conversationId });
      if (handoff.queueId) await offerToNextExec(tx, actor, conversationId, handoff.id, handoff.queueId, exclude, now);
    });
  }

  /** Take over directly from the AI (design/01 "Take over"). */
  async takeOver(actor: ActorContext, conversationId: string): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_TAKE_OVER);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const before = await lockConversation(tx, conversationId);
      await applyControl(tx, conversationId, {
        command: 'TAKE_OVER',
        actor,
        transitionActor: 'HUMAN',
        description: `taken over by ${nameOf(actor)} · agent remains attached`,
        patch: { assignedUserId: actor.principal!.userId, waitingSince: null },
        now,
      });
      const existing = await openHandoff(tx, conversationId);
      if (!existing) {
        await tx.insert(handoffs).values({
          id: uuidv7(),
          conversationId,
          trigger: 'HUMAN_REQUEST',
          reasonCode: 'human_take_over',
          reasonText: `${nameOf(actor)} took over`,
          requestedByType: 'HUMAN',
          requestedById: actor.principal!.userId,
          mode: 'OPEN_PICKUP',
          queueId: before.queueId,
          priority: before.priority,
          status: 'ACTIVE',
          assignedUserId: actor.principal!.userId,
          requestedAt: now,
          acceptedAt: now,
        });
      }
      await this.activateHandoff(tx, actor, conversationId, 'TAKE_OVER', now);
    });
  }

  /** Transfer to another queue or user; the conversation waits again. */
  async transfer(actor: ActorContext, conversationId: string, input: z.infer<typeof TransferInput>): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_TRANSFER);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const conv = await lockConversation(tx, conversationId);
      this.assertHandler(actor, conv.assignedUserId);
      await endOpenAssignment(tx, conversationId, 'transferred', now);
      await applyControl(tx, conversationId, {
        command: 'RELEASE_TO_QUEUE',
        actor,
        transitionActor: 'HUMAN',
        description: `transferred by ${nameOf(actor)}`,
        patch: { assignedUserId: null, waitingSince: now, ...(input.queueId ? { queueId: input.queueId } : {}) },
        now,
      });
      const handoff = await openHandoff(tx, conversationId);
      if (handoff) await tx.update(handoffs).set({ status: 'WAITING', assignedUserId: null, ...(input.queueId ? { queueId: input.queueId } : {}) }).where(eq(handoffs.id, handoff.id));
      if (input.userId && handoff) {
        await tx.update(conversations).set({ assignedUserId: input.userId }).where(eq(conversations.id, conversationId));
        await tx.update(handoffs).set({ status: 'OFFERED', assignedUserId: input.userId, offeredAt: now }).where(eq(handoffs.id, handoff.id));
        await tx.insert(assignments).values({ id: uuidv7(), conversationId, userId: input.userId, handoffId: handoff.id, kind: 'TRANSFER', assignedBy: actor.principal!.userId, assignedAt: now });
      }
      await emitEvent(tx, actor, 'assignment.changed', { userId: input.userId ?? null, previousUserId: conv.assignedUserId, kind: 'TRANSFER' }, { conversationId });
    });
  }

  /** Return control to the same agent with a handover summary (design/01 "Return to AI"). */
  async returnToAi(actor: ActorContext, conversationId: string, input: z.infer<typeof ReturnToAiInput>): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_RETURN_TO_AI);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const conv = await lockConversation(tx, conversationId);
      this.assertHandler(actor, conv.assignedUserId);
      await applyControl(tx, conversationId, {
        command: 'RETURN_TO_AI',
        actor,
        transitionActor: 'HUMAN',
        description: 'control returning to AI · handover summary written · agent resumes on next customer turn',
        now,
      });
      const [last] = await tx
        .select({ v: max(conversationSummaries.version) })
        .from(conversationSummaries)
        .where(and(eq(conversationSummaries.conversationId, conversationId), eq(conversationSummaries.kind, 'HANDOVER')));
      await tx.insert(conversationSummaries).values({
        id: uuidv7(),
        conversationId,
        version: (last?.v ?? 0) + 1,
        coversThroughSeq: conv.lastSeq,
        kind: 'HANDOVER',
        text: input.handoverSummary,
        createdBy: actor.principal!.userId,
      });
      // Everything so far was handled by the human; the agent answers only new messages.
      await tx.update(conversations).set({ lastProcessedSeq: sql`${conversations.lastSeq}` }).where(eq(conversations.id, conversationId));
      const handoff = await openHandoff(tx, conversationId);
      if (handoff) await tx.update(handoffs).set({ status: 'RETURNED', returnedAt: now, handoverSummary: input.handoverSummary }).where(eq(handoffs.id, handoff.id));
    });
  }

  async cancelReturn(actor: ActorContext, conversationId: string): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_RETURN_TO_AI);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      const conv = await lockConversation(tx, conversationId);
      this.assertHandler(actor, conv.assignedUserId);
      await applyControl(tx, conversationId, { command: 'CANCEL_RETURN', actor, transitionActor: 'HUMAN', description: `return cancelled by ${nameOf(actor)}`, now });
      const [last] = await tx.select().from(handoffs).where(eq(handoffs.conversationId, conversationId)).orderBy(desc(handoffs.requestedAt)).limit(1);
      if (last?.status === 'RETURNED') await tx.update(handoffs).set({ status: 'ACTIVE', returnedAt: null }).where(eq(handoffs.id, last.id));
    });
  }

  async resolve(actor: ActorContext, conversationId: string, input: z.infer<typeof ResolveInput>): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_RESOLVE);
    await this.db.transaction(async (tx) => {
      const now = this.now();
      await applyControl(tx, conversationId, {
        command: 'RESOLVE',
        actor,
        transitionActor: 'HUMAN',
        description: `resolved by ${nameOf(actor)}${input.disposition ? ` · disposition: ${input.disposition}` : ''}`,
        patch: { resolvedAt: now, resolvedBy: actor.principal!.userId, disposition: input.disposition ?? null, waitingSince: null },
        now,
      });
      await endOpenAssignment(tx, conversationId, 'resolved', now);
      const handoff = await openHandoff(tx, conversationId);
      if (handoff) await tx.update(handoffs).set({ status: 'RESOLVED', resolvedAt: now }).where(eq(handoffs.id, handoff.id));
      await emitEvent(tx, actor, 'conversation.resolved', { disposition: input.disposition ?? null, resolvedBy: actor.principal!.userId }, { conversationId });
    });
  }

  async reopen(actor: ActorContext, conversationId: string): Promise<void> {
    assertCan(actor.principal!, Permission.CONVERSATIONS_TAKE_OVER);
    await this.db.transaction(async (tx) => {
      await applyControl(tx, conversationId, {
        command: 'REOPEN',
        actor,
        transitionActor: 'HUMAN',
        reopenedBy: 'HUMAN',
        description: `reopened by ${nameOf(actor)}`,
        patch: { assignedUserId: actor.principal!.userId },
        now: this.now(),
      });
      await tx.insert(assignments).values({ id: uuidv7(), conversationId, userId: actor.principal!.userId, kind: 'REOPEN', assignedAt: this.now() });
    });
  }

  private async activateHandoff(tx: DbOrTx, actor: ActorContext, conversationId: string, kind: 'CLAIM' | 'TAKE_OVER' | null, now: Date): Promise<void> {
    const handoff = await openHandoff(tx, conversationId);
    if (handoff) {
      await tx.update(handoffs).set({ status: 'ACTIVE', acceptedAt: now, assignedUserId: actor.principal!.userId }).where(eq(handoffs.id, handoff.id));
    }
    if (kind) {
      await endOpenAssignment(tx, conversationId, 'superseded', now);
      await tx.insert(assignments).values({ id: uuidv7(), conversationId, userId: actor.principal!.userId, handoffId: handoff?.id ?? null, kind, assignedAt: now, acceptedAt: now });
    }
    await tx.update(users).set({ lastAssignedAt: now }).where(eq(users.id, actor.principal!.userId));
    await emitEvent(tx, actor, 'assignment.changed', { userId: actor.principal!.userId, previousUserId: null, kind: kind ?? 'ACCEPT' }, { conversationId });
  }

  /** Only the handling human (or a lead with assign rights) may act for the conversation. */
  private assertHandler(actor: ActorContext, assignedUserId: string | null): void {
    const p = actor.principal!;
    if (assignedUserId === p.userId || can(p, Permission.CONVERSATIONS_ASSIGN)) return;
    throw validation('not_handler', 'Only the human handling this conversation can do that');
  }
}
