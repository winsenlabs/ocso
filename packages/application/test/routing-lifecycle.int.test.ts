import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { IDLE_DISPOSITION, type RouterDefinition } from '@ocso/domain';
import { channels, conversations, handoffs, virtualAgents } from '@ocso/db';
import { createActiveRouter, disableRouter } from '../src/index.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * A routed conversation stays with its agent for every later message, until it stops making sense to: its agent
 * stops answering (paused: back through the channel's router), the channel switches routers (the next message goes
 * through the new one), or it goes quiet past the channel's `aiIdleResolveHours` (resolved; the next message is
 * routed afresh). A person's conversation is never moved.
 */
let f: RoutingFixture;
const PASS: RouterDefinition = { steps: [], rules: [], fallbackQueueId: 'CARDS', returning: null, timeoutMinutes: 10 };
let menu: RouterDefinition;

beforeAll(async () => {
  f = await createRoutingFixture();
  menu = {
    steps: [{ id: 'product', kind: 'ASK', attribute: 'product', prompt: { text: 'Which?' }, options: [{ value: 'cards', label: 'Cards', synonyms: [] }, { value: 'sales', label: 'Loans', synonyms: [] }], maxAttempts: 2, skipIfKnown: false }],
    rules: [{ when: { product: 'sales' }, queueId: f.queues.sales }],
    fallbackQueueId: f.queues.cards,
    returning: null,
    timeoutMinutes: 10,
  };
});
afterAll(async () => {
  await f?.drop();
});
beforeEach(async () => {
  f.now.value = new Date();
  await f.t.db.update(virtualAgents).set({ status: 'LIVE' }).where(inArray(virtualAgents.id, [f.agents.maya, f.agents.arjun]));
});

const pause = (id: string) => f.t.db.update(virtualAgents).set({ status: 'PAUSED' }).where(eq(virtualAgents.id, id));
/** The agent answered everything so far (what a completed turn leaves behind). */
const answered = async (id: string) => {
  const c = await f.conversation(id);
  await f.t.db.update(conversations).set({ lastProcessedSeq: c.lastSeq }).where(eq(conversations.id, id));
};
/** Routes a new customer on a menu channel to the Cards queue (Maya). */
async function withMaya(channel: string, phone: string) {
  const a = await f.say(channel, 'hi', phone);
  await f.engine.advance(a.conversationId, 'r1');
  await f.say(channel, 'Cards', phone);
  await f.engine.advance(a.conversationId, 'r2');
  expect(await f.conversation(a.conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya });
  await answered(a.conversationId);
  return a.conversationId;
}

describe('later messages', () => {
  it('go straight to the agent: no router, a turn', async () => {
    const channel = await f.channelWith(menu, 'Sticky');
    const id = await withMaya(channel, '+919870000001');
    const next = await f.say(channel, 'and my statement?', '+919870000001');
    expect(next).toMatchObject({ conversationId: id, created: false, routeQueued: false, turnQueued: true });
  });
});

describe('an agent that stops answering', () => {
  it('sends its customer back through the channel’s router on their next message', async () => {
    const channel = await f.channelWith(menu, 'Paused next message');
    const id = await withMaya(channel, '+919870000002');
    await pause(f.agents.maya);
    const next = await f.say(channel, 'hello??', '+919870000002');
    expect(next).toMatchObject({ conversationId: id, routeQueued: true, turnQueued: false });
    expect((await f.conversation(id)).controlState).toBe('ROUTING');
    expect(await f.routing(id)).toMatchObject({ phase: 'STEPS', previousState: 'AI_ACTIVE' });
    await f.engine.advance(id, 'r3');
    await f.say(channel, 'Loans', '+919870000002');
    await f.engine.advance(id, 'r4');
    expect(await f.conversation(id)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun, queueId: f.queues.sales });
    expect(f.queue.count('conversation.turn', id)).toBeGreaterThan(0);
  });

  it('a customer already waiting is picked up by the sweep, within a minute', async () => {
    const channel = await f.channelWith(menu, 'Paused stranded');
    const id = await withMaya(channel, '+919870000003');
    // Written while Maya was live; the turn never ran (she was paused first).
    await f.say(channel, 'are you there?', '+919870000003');
    await pause(f.agents.maya);
    const routes = f.queue.count('conversation.route', id);
    const swept = await f.engine.sweep('sweep');
    expect(swept.rerouted).toBeGreaterThanOrEqual(1);
    expect((await f.conversation(id)).controlState).toBe('ROUTING');
    expect(f.queue.count('conversation.route', id)).toBe(routes + 1);
  });

  it('with no active router on the channel, a person on its queue takes it instead of silence', async () => {
    const channel = await f.channelWith(PASS, 'Paused no router');
    const first = await f.say(channel, 'hi', '+919870000004');
    await answered(first.conversationId);
    const [row] = await f.t.db.select({ routerId: channels.routerId }).from(channels).where(eq(channels.id, channel));
    await f.t.db.transaction((tx) => disableRouter(tx, f.actor, row!.routerId!));
    await pause(f.agents.maya);
    await f.say(channel, 'hello??', '+919870000004');
    expect((await f.conversation(first.conversationId)).controlState).toBe('WAITING_FOR_HUMAN');
    const [h] = await f.t.db.select().from(handoffs).where(eq(handoffs.conversationId, first.conversationId));
    expect(h).toMatchObject({ reasonCode: 'agent_unavailable', status: 'WAITING' });
  });
});

describe('a channel that switches routers', () => {
  it('sends AI-held conversations through the new router on their next message', async () => {
    const channel = await f.channelWith(PASS, 'Switching');
    const first = await f.say(channel, 'hi', '+919870000005');
    await answered(first.conversationId);
    expect((await f.conversation(first.conversationId)).agentId).toBe(f.agents.maya);
    await createActiveRouter(f.t.db, f.actor, { name: 'Switching v2', definition: { ...PASS, fallbackQueueId: f.queues.sales }, channelIds: [channel] });
    const next = await f.say(channel, 'hello again', '+919870000005');
    expect(next).toMatchObject({ conversationId: first.conversationId, routeQueued: true });
    await f.engine.advance(first.conversationId, 'r1');
    expect(await f.conversation(first.conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun, queueId: f.queues.sales });
    // Once placed by the new router, later messages go straight to the agent again.
    await answered(first.conversationId);
    expect(await f.say(channel, 'thanks', '+919870000005')).toMatchObject({ routeQueued: false, turnQueued: true });
  });
});

describe('quiet AI conversations', () => {
  it('resolve after the channel’s quiet period; the next message is routed afresh, never reopened', async () => {
    const channel = await f.channelWith(PASS, 'Quiet');
    const first = await f.say(channel, 'hi', '+919870000006');
    await answered(first.conversationId);
    f.now.value = new Date(Date.now() + 23 * 3_600_000);
    await f.t.db.update(conversations).set({ lastInteractionAt: new Date() }).where(eq(conversations.id, first.conversationId));
    await f.engine.sweep('early');
    expect((await f.conversation(first.conversationId)).controlState).toBe('AI_ACTIVE');
    f.now.value = new Date(Date.now() + 25 * 3_600_000);
    expect((await f.engine.sweep('late')).idleResolved).toBeGreaterThanOrEqual(1);
    expect(await f.conversation(first.conversationId)).toMatchObject({ controlState: 'RESOLVED', disposition: IDLE_DISPOSITION });
    const again = await f.say(channel, 'hello, new question', '+919870000006');
    expect(again.created).toBe(true);
    expect(again.conversationId).not.toBe(first.conversationId);
  });

  it('a waiting customer, a person’s conversation, and a channel set to 0 are never resolved', async () => {
    const channel = await f.channelWith(PASS, 'Quiet never');
    await f.t.db.update(channels).set({ settings: { aiIdleResolveHours: 0 } }).where(eq(channels.id, channel));
    const off = await f.say(channel, 'hi', '+919870000007');
    await answered(off.conversationId);
    const busy = await f.channelWith(PASS, 'Quiet waiting');
    const waiting = await f.say(busy, 'hi', '+919870000008');
    f.now.value = new Date(Date.now() + 48 * 3_600_000);
    await f.engine.sweep('late');
    expect((await f.conversation(off.conversationId)).controlState).toBe('AI_ACTIVE');
    expect((await f.conversation(waiting.conversationId)).controlState).toBe('AI_ACTIVE');
  });
});

describe('a router with a persona and a greeting', () => {
  it('greets a new conversation, classifies in the persona’s voice, and does not greet again when routing a conversation again', async () => {
    const persona = { name: 'Asha', voice: 'Warm and brief.' };
    const seen: Array<{ persona: unknown }> = [];
    f.classify.impl = async (r) => {
      seen.push({ persona: r.persona });
      return { label: 'sales', confidence: 0.9, followUp: null };
    };
    const def: RouterDefinition = {
      persona,
      greeting: { text: 'Hi, I’m Asha. Let me find the right team.' },
      steps: [{ id: 'need', kind: 'CLASSIFY', attribute: 'product', modelProfileId: (await f.t.pool.query('SELECT id FROM model_profiles LIMIT 1')).rows[0].id, instructions: '', labels: [{ value: 'cards', description: 'cards' }, { value: 'sales', description: 'loans' }], minConfidence: 0.5, maxFollowUps: 1, skipIfKnown: false }],
      rules: [{ when: { product: 'sales' }, queueId: f.queues.sales }],
      fallbackQueueId: f.queues.cards,
      returning: null,
      timeoutMinutes: 10,
    };
    const channel = await f.channelWith(def, 'Persona');
    const a = await f.say(channel, 'I want a loan', '+919870000009');
    await f.engine.advance(a.conversationId, 'r1');
    const said = (await f.routerMessages(a.conversationId)).map((m) => (m.parts[0] as { text?: string }).text);
    expect(said).toEqual(['Hi, I’m Asha. Let me find the right team.']);
    expect(seen.at(-1)?.persona).toEqual(persona);
    expect(await f.conversation(a.conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun });

    // Arjun stops answering: routed again, without a second greeting.
    await answered(a.conversationId);
    await pause(f.agents.arjun);
    await f.say(channel, 'still there?', '+919870000009');
    await f.engine.advance(a.conversationId, 'r2');
    expect((await f.routerMessages(a.conversationId)).length).toBe(1);
    f.classify.impl = null;
  });

  it('a pass-through router with a greeting greets, then hands the customer to its agent', async () => {
    const channel = await f.channelWith({ ...PASS, greeting: { text: 'Hello from Meridian!' } }, 'Greeting pass-through');
    const a = await f.say(channel, 'hi', '+919870000010');
    expect(a).toMatchObject({ routeQueued: true, turnQueued: false });
    await f.engine.advance(a.conversationId, 'r1');
    expect((await f.routerMessages(a.conversationId)).map((m) => (m.parts[0] as { text?: string }).text)).toEqual(['Hello from Meridian!']);
    expect(await f.conversation(a.conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya });
    expect(f.queue.count('conversation.turn', a.conversationId)).toBeGreaterThan(0);
  });
});
