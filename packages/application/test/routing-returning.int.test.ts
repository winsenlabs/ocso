import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import type { RouterDefinition } from '@ocso/domain';
import { conversations, interactions } from '@ocso/db';
import { HumanControlService } from '../src/index.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * Returning customers (PM/research/11 §5.3): after the router's askAfter gap
 * the customer is asked continue-or-new; continue restores the conversation
 * (a resolved one reopens), new resolves it and starts a new conversation
 * carrying the messages that brought them back.
 */
let f: RoutingFixture;
let channel: string;
const HOUR = 3_600_000;

const RETURNING: RouterDefinition = {
  steps: [],
  rules: [],
  fallbackQueueId: 'CARDS',
  returning: { askAfter: { value: 2, unit: 'HOURS' }, prompt: { text: 'Welcome back! Continue, or start something new?' }, continueLabel: 'Continue', newLabel: 'Something new' },
  timeoutMinutes: 10,
};

beforeAll(async () => {
  f = await createRoutingFixture();
  channel = await f.channelWith(RETURNING, 'Returning');
});
afterAll(async () => {
  await f?.drop();
});

/** A pass-through conversation whose customer last wrote `hoursAgo` hours ago, the agent's reply answered. */
async function oldConversation(phone: string, hoursAgo: number): Promise<string> {
  f.now.value = new Date(Date.now() - hoursAgo * HOUR);
  const { conversationId } = await f.say(channel, 'my card is blocked', phone);
  f.now.value = new Date();
  // The agent answered everything so far.
  const conv = await f.conversation(conversationId);
  await f.t.db.update(conversations).set({ lastProcessedSeq: conv.lastSeq }).where(eq(conversations.id, conversationId));
  return conversationId;
}

describe('returning customers', () => {
  it('within the gap the message simply joins the conversation', async () => {
    const id = await oldConversation('+919811000001', 1);
    const r = await f.say(channel, 'still there?', '+919811000001');
    expect(r).toMatchObject({ conversationId: id, created: false, routeQueued: false, turnQueued: true });
    expect((await f.conversation(id)).controlState).toBe('AI_ACTIVE');
  });

  it('after the gap: ROUTING with the question; "continue" restores AI_ACTIVE and the agent answers the new message', async () => {
    const id = await oldConversation('+919811000002', 3);
    const before = await f.conversation(id);
    const r = await f.say(channel, 'hello again', '+919811000002');
    expect(r).toMatchObject({ conversationId: id, created: false, routeQueued: true, turnQueued: false });
    expect(await f.conversation(id)).toMatchObject({ controlState: 'ROUTING', agentId: f.agents.maya });
    expect(await f.routing(id)).toMatchObject({ phase: 'RETURNING', previousState: 'AI_ACTIVE', seqFrom: before.lastProcessedSeq });

    await f.engine.advance(id, 'r1');
    const [question] = await f.routerMessages(id);
    expect(question?.parts[0]).toMatchObject({ data: { options: [{ id: 'ocso:returning:continue', label: 'Continue' }, { id: 'ocso:returning:new', label: 'Something new' }] } });

    await f.say(channel, '1', '+919811000002');
    await f.engine.advance(id, 'r2');
    const after = await f.conversation(id);
    expect(after).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, lastProcessedSeq: before.lastProcessedSeq });
    expect(await f.routing(id)).toMatchObject({ phase: 'DONE', outcome: 'CONTINUE' });
    expect(f.queue.count('conversation.turn', id)).toBeGreaterThan(0);
  });

  it('"new": the old conversation is resolved and a new one starts with the carried message', async () => {
    const oldId = await oldConversation('+919811000003', 3);
    await f.say(channel, 'I have a new question about loans', '+919811000003');
    await f.engine.advance(oldId, 'r1');
    await f.say(channel, 'something new', '+919811000003');
    await f.engine.advance(oldId, 'r2');

    const old = await f.conversation(oldId);
    expect(old).toMatchObject({ controlState: 'RESOLVED', disposition: 'CUSTOMER_STARTED_NEW' });
    expect(await f.routing(oldId)).toMatchObject({ outcome: 'NEW' });
    const [fresh] = await f.t.db.select().from(conversations).where(and(eq(conversations.customerId, old.customerId), eq(conversations.controlState, 'AI_ACTIVE')));
    expect(fresh).toBeDefined();
    expect(fresh!.id).not.toBe(oldId);
    // Pass-through: the new conversation was routed straight away; its agent answers the carried message.
    expect(fresh).toMatchObject({ agentId: f.agents.maya, queueId: f.queues.cards, lastProcessedSeq: 0 });
    const carried = await f.t.db.select({ key: interactions.idempotencyKey, preview: interactions.preview }).from(interactions).where(and(eq(interactions.conversationId, fresh!.id), like(interactions.idempotencyKey, '%:carried')));
    expect(carried.map((c) => c.preview)).toEqual(['I have a new question about loans']);
    expect(f.queue.count('conversation.turn', fresh!.id)).toBe(1);
  });

  it('a conversation resolved within the reopen window is asked too, and reopens on "continue"', async () => {
    const id = await oldConversation('+919811000004', 5);
    await new HumanControlService(f.t.db).resolve(f.actor, id, {});
    await f.say(channel, 'hi again', '+919811000004');
    // Asking is not reopening: it stays resolved (time, count) until the customer chooses to continue.
    const asking = await f.conversation(id);
    expect(asking).toMatchObject({ controlState: 'ROUTING', reopenCount: 0 });
    expect(asking.resolvedAt).not.toBeNull();
    expect(await f.routing(id)).toMatchObject({ phase: 'RETURNING', previousState: 'RESOLVED' });
    await f.engine.advance(id, 'r1');
    await f.say(channel, 'continue', '+919811000004');
    await f.engine.advance(id, 'r2');
    expect(await f.conversation(id)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, resolvedAt: null, reopenCount: 1 });
  });

  it('a resolved conversation whose customer chooses "new" stays resolved as it was: no second resolution, no reopen', async () => {
    const id = await oldConversation('+919811000006', 5);
    await new HumanControlService(f.t.db).resolve(f.actor, id, {});
    const resolved = await f.conversation(id);
    await f.say(channel, 'something else entirely', '+919811000006');
    await f.engine.advance(id, 'r1');
    await f.say(channel, 'new', '+919811000006');
    await f.engine.advance(id, 'r2');
    const after = await f.conversation(id);
    expect(after).toMatchObject({ controlState: 'RESOLVED', reopenCount: 0, disposition: resolved.disposition });
    expect(after.resolvedAt?.getTime()).toBe(resolved.resolvedAt?.getTime());
    const resolutions = await f.t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'conversation.resolved' AND conversation_id = $1`, [id]);
    expect(resolutions.rows[0].n).toBe(1);
  });

  it('no clear answer after two questions continues the conversation', async () => {
    const id = await oldConversation('+919811000005', 3);
    await f.say(channel, 'hey', '+919811000005');
    await f.engine.advance(id, 'r1');
    await f.say(channel, 'what?', '+919811000005');
    await f.engine.advance(id, 'r2');
    expect(await f.routerMessages(id)).toHaveLength(2);
    await f.say(channel, 'hmm', '+919811000005');
    await f.engine.advance(id, 'r3');
    expect(await f.conversation(id)).toMatchObject({ controlState: 'AI_ACTIVE' });
    expect(await f.routing(id)).toMatchObject({ outcome: 'CONTINUE' });
  });
});
