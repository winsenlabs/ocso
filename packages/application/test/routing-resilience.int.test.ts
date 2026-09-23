import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { RouterDefinition } from '@ocso/domain';
import { channels, conversationRouting, queues, routers, uuidv7 } from '@ocso/db';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * The routing engine under the conditions production brings (PM/research/11
 * §5.3): timeouts across several questions, answers that race the sweep,
 * bursts of messages, queues that lose their agents, and a sweep that must
 * not be crowded out by long-timeout routers.
 */
let f: RoutingFixture;
beforeAll(async () => {
  f = await createRoutingFixture();
});
afterAll(async () => {
  await f?.drop();
});

const ask = (id: string, attribute: string, options: Array<[string, string]>) => ({
  id,
  kind: 'ASK' as const,
  attribute,
  prompt: { text: `Question ${id}?` },
  options: options.map(([value, label]) => ({ value, label, synonyms: [] })),
  maxAttempts: 2,
  skipIfKnown: false,
});
const TWO_STEPS: RouterDefinition = {
  steps: [ask('product', 'product', [['cards', 'Cards'], ['sales', 'Loans']]), ask('lang', 'language', [['en', 'English'], ['ta', 'Tamil']])],
  rules: [{ when: { product: 'sales' }, queueId: 'SALES' }],
  fallbackQueueId: 'CARDS',
  returning: null,
  timeoutMinutes: 10,
};
const ONE_STEP: RouterDefinition = { ...TWO_STEPS, steps: [TWO_STEPS.steps[0]!] };
const minutesAgo = (n: number) => sql`now() - make_interval(mins => ${n})`;
const age = (conversationId: string, set: Partial<Record<'awaitingSince' | 'updatedAt', ReturnType<typeof minutesAgo>>>) =>
  f.t.db.update(conversationRouting).set(set).where(eq(conversationRouting.conversationId, conversationId));

describe('timeouts', () => {
  it('measure silence since the last question, not the whole menu', async () => {
    const channel = await f.channelWith(TWO_STEPS, 'Two steps');
    const { conversationId } = await f.say(channel, 'hi', '+919870000001');
    await f.engine.advance(conversationId, 'r1');
    // The customer answers question 1 at minute 9 of a 10-minute timeout…
    await age(conversationId, { awaitingSince: minutesAgo(9) });
    await f.say(channel, '2', '+919870000001');
    await f.engine.advance(conversationId, 'r2');
    const row = await f.routing(conversationId);
    expect(row).toMatchObject({ stepIndex: 1, attempts: 1 });
    expect(row?.awaitingSince?.getTime()).toBe(f.now.value.getTime());
    // …and a minute after question 2 nothing times out.
    const saved = f.now.value;
    f.now.value = new Date(saved.getTime() + 60_000);
    await f.engine.sweep('sweep-a');
    f.now.value = saved;
    expect((await f.conversation(conversationId)).controlState).toBe('ROUTING');
  });

  it('an answer stored before the sweep ran counts; the timeout does not override it', async () => {
    const channel = await f.channelWith({ ...ONE_STEP, timeoutMinutes: 5 }, 'Race');
    const { conversationId } = await f.say(channel, 'hi', '+919870000002');
    await f.engine.advance(conversationId, 'r1');
    await f.say(channel, '2', '+919870000002'); // the route job for it is delayed
    await age(conversationId, { awaitingSince: minutesAgo(6) });
    await f.engine.sweep('sweep-b');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun, queueId: f.queues.sales });
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'RULE' });
  });

  it('a long-timeout router cannot crowd a short one out of the sweep', async () => {
    const longChannel = await f.channelWith({ ...ONE_STEP, timeoutMinutes: 1440 }, 'Long');
    const [longRouter] = await f.t.db.select({ id: routers.id, versionId: routers.activeVersionId }).from(channels).innerJoin(routers, eq(routers.id, channels.routerId)).where(eq(channels.id, longChannel));
    // 100 customers waiting 30 minutes on a router whose timeout is a day: older than anything else, never due.
    await f.t.pool.query(
      `WITH c AS (INSERT INTO customers (id, display_name) SELECT gen_random_uuid(), 'bulk ' || g FROM generate_series(1, 100) g RETURNING id),
            conv AS (INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state) SELECT gen_random_uuid(), c.id, NULL, $1, 'SUPPORT', 'ROUTING' FROM c RETURNING id)
       INSERT INTO conversation_routing (conversation_id, router_id, router_version_id, phase, awaiting_since, updated_at)
       SELECT id, $2, $3, 'STEPS', now() - interval '30 minutes', now() FROM conv`,
      [longChannel, longRouter!.id, longRouter!.versionId],
    );
    const channel = await f.channelWith({ ...ONE_STEP, timeoutMinutes: 5 }, 'Short');
    const { conversationId } = await f.say(channel, 'hi', '+919870000003');
    await f.engine.advance(conversationId, 'r1');
    await age(conversationId, { awaitingSince: minutesAgo(6) });
    const result = await f.engine.sweep('sweep-c');
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'TIMEOUT', phase: 'DONE' });
  });
});

describe('bursts', () => {
  it('messages sent before a question was shown do not answer it', async () => {
    const channel = await f.channelWith(TWO_STEPS, 'Burst');
    const { conversationId } = await f.say(channel, 'hi', '+919870000004');
    await f.engine.advance(conversationId, 'r1');
    await f.say(channel, '2', '+919870000004');
    await f.say(channel, 'thanks!', '+919870000004');
    await f.engine.advance(conversationId, 'r2');
    expect(await f.routing(conversationId)).toMatchObject({ stepIndex: 1, attempts: 1, answers: { product: 'sales' } });
    expect(await f.routerMessages(conversationId)).toHaveLength(2);
  });
});

describe('queues that lose their agents', () => {
  it('routing waits (visible, retried) instead of dying; it finishes once a queue has an agent again', async () => {
    const [qx, qy] = [uuidv7(), uuidv7()];
    await f.t.db.insert(queues).values([
      { id: qx, name: 'Lost X', agentId: f.agents.arjun },
      { id: qy, name: 'Lost Y', agentId: f.agents.maya },
    ]);
    const channel = await f.channelWith({ ...ONE_STEP, rules: [{ when: { product: 'sales' }, queueId: qx }], fallbackQueueId: qy }, 'Lost');
    const { conversationId } = await f.say(channel, 'hi', '+919870000005');
    await f.engine.advance(conversationId, 'r1');
    await f.say(channel, '2', '+919870000005');
    // Both agents deleted since activation (queues.agent_id is ON DELETE SET NULL).
    await f.t.db.update(queues).set({ agentId: null }).where(sql`${queues.id} IN (${qx}, ${qy})`);
    const turns = f.queue.count('conversation.turn', conversationId);
    await f.engine.advance(conversationId, 'r2');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'ROUTING', agentId: null });
    expect(await f.routing(conversationId)).toMatchObject({ phase: 'STEPS', stepIndex: 1, answers: { product: 'sales' }, awaitingSince: null });
    // A new message retries at once (still nothing to route to): one timeline entry, not one per retry.
    await f.say(channel, 'hello?', '+919870000005');
    await f.engine.advance(conversationId, 'r3');
    expect(await f.systemEvents(conversationId, 'system.routing_blocked')).toHaveLength(1);
    expect(f.queue.count('conversation.turn', conversationId)).toBe(turns);

    await f.t.db.update(queues).set({ agentId: f.agents.maya }).where(eq(queues.id, qy));
    await age(conversationId, { updatedAt: minutesAgo(2) });
    const route = f.queue.count('conversation.route', conversationId);
    await f.engine.sweep('sweep-d');
    expect(f.queue.count('conversation.route', conversationId)).toBe(route + 1);
    await f.engine.advance(conversationId, 'r4');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, queueId: qy, lastProcessedSeq: 0 });
    expect(await f.routing(conversationId)).toMatchObject({ phase: 'DONE', outcome: 'FALLBACK' });
    expect(f.queue.count('conversation.turn', conversationId)).toBe(turns + 1);
  });

  it('a session left DONE while still ROUTING (before this fix) is picked up by the sweep and decided', async () => {
    const channel = await f.channelWith(ONE_STEP, 'Legacy');
    const { conversationId } = await f.say(channel, 'hi', '+919870000006');
    await f.engine.advance(conversationId, 'r1');
    await age(conversationId, { updatedAt: minutesAgo(2) });
    await f.t.db.update(conversationRouting).set({ phase: 'DONE', awaitingSince: null }).where(eq(conversationRouting.conversationId, conversationId));
    await f.engine.sweep('sweep-e');
    await f.engine.advance(conversationId, 'r2');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, queueId: f.queues.cards });
  });
});

describe('stalled sessions', () => {
  it('are re-signalled for an unanswered customer message, not for the router’s own question', async () => {
    const channel = await f.channelWith(ONE_STEP, 'Quiet');
    const { conversationId } = await f.say(channel, 'hi', '+919870000007');
    await f.engine.advance(conversationId, 'r1');
    await age(conversationId, { updatedAt: minutesAgo(2) });
    const route = f.queue.count('conversation.route', conversationId);
    await f.engine.sweep('sweep-f');
    expect(f.queue.count('conversation.route', conversationId)).toBe(route);
    await f.say(channel, 'Loans', '+919870000007');
    await age(conversationId, { updatedAt: minutesAgo(2) });
    const afterSay = f.queue.count('conversation.route', conversationId);
    await f.engine.sweep('sweep-g');
    expect(f.queue.count('conversation.route', conversationId)).toBe(afterSay + 1);
  });
});
