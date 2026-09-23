import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { CHOICES_SCHEMA, type RouterDefinition } from '@ocso/domain';
import { conversationRouting, conversations, customers } from '@ocso/db';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * The routing engine (PM/research/11 §5.3): menus, re-asks, button taps,
 * KNOWN attributes, model classification with follow-ups, fallback and
 * timeout. Queue ids CARDS/SALES are filled in by the fixture.
 */
let f: RoutingFixture;
beforeAll(async () => {
  f = await createRoutingFixture();
});
afterAll(async () => {
  await f?.drop();
});

const MENU: RouterDefinition = {
  steps: [
    {
      id: 'product',
      kind: 'ASK',
      attribute: 'product',
      prompt: { text: 'What can we help with?' },
      options: [
        { value: 'cards', label: 'Cards & EMI', synonyms: ['card'] },
        { value: 'sales', label: 'Loans', synonyms: ['loan'] },
      ],
      maxAttempts: 2,
      skipIfKnown: false,
    },
  ],
  rules: [{ when: { product: 'sales' }, queueId: 'SALES' }],
  fallbackQueueId: 'CARDS',
  returning: null,
  timeoutMinutes: 10,
};

describe('menu routing', () => {
  let channel: string;
  beforeAll(async () => {
    channel = await f.channelWith(MENU, 'Menu');
  });

  it('opens a ROUTING conversation with no agent, asks with CHOICES and routes on the answer', async () => {
    const first = await f.say(channel, 'hi, I want a loan quote', '+919800100001');
    expect(first).toMatchObject({ created: true, routeQueued: true, turnQueued: false });
    const opened = await f.conversation(first.conversationId);
    expect(opened).toMatchObject({ controlState: 'ROUTING', agentId: null, queueId: null });

    await f.engine.advance(first.conversationId, 'r1');
    const [ask] = await f.routerMessages(first.conversationId);
    expect(ask?.parts[0]).toMatchObject({
      type: 'STRUCTURED',
      schema: CHOICES_SCHEMA,
      data: { text: 'What can we help with?', options: [{ id: 'ocso:product:cards', label: 'Cards & EMI' }, { id: 'ocso:product:sales', label: 'Loans' }] },
      fallbackText: 'What can we help with?\n\n1. Cards & EMI\n2. Loans',
    });
    expect(f.queue.count('channel.deliver')).toBeGreaterThan(0);
    // The opening message is not an answer to the question asked after it.
    expect((await f.routing(first.conversationId))?.attempts).toBe(1);

    const reply = await f.say(channel, '2', '+919800100001');
    expect(reply).toMatchObject({ conversationId: first.conversationId, created: false, routeQueued: true });
    await f.engine.advance(first.conversationId, 'r2');
    const routed = await f.conversation(first.conversationId);
    expect(routed).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun, queueId: f.queues.sales, type: 'SALES', lastProcessedSeq: 0 });
    expect(await f.routing(first.conversationId)).toMatchObject({ phase: 'DONE', outcome: 'RULE', ruleIndex: 0, queueId: f.queues.sales, attributes: { product: 'sales' }, answers: { product: 'sales' } });
    expect(await f.systemEvents(first.conversationId, 'system.routed')).toEqual(['Routed to Sales — rule 1: product=sales']);
    expect(f.queue.count('conversation.turn', first.conversationId)).toBe(1);
  });

  it('re-asks an unclear answer and falls back after maxAttempts', async () => {
    const { conversationId } = await f.say(channel, 'hello', '+919800100002');
    await f.engine.advance(conversationId, 'r1');
    await f.say(channel, 'hmm what', '+919800100002');
    await f.engine.advance(conversationId, 'r2');
    expect(await f.routerMessages(conversationId)).toHaveLength(2);
    expect((await f.conversation(conversationId)).controlState).toBe('ROUTING');
    await f.say(channel, 'no idea', '+919800100002');
    await f.engine.advance(conversationId, 'r3');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, queueId: f.queues.cards });
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'FALLBACK', ruleIndex: null, attributes: {} });
  });

  it('matches a tapped button by its option id, and a synonym inside a sentence', async () => {
    const tap = await f.say(channel, 'hi', '+919800100003');
    await f.engine.advance(tap.conversationId, 'r1');
    await f.say(channel, '', '+919800100003', [{ type: 'STRUCTURED', schema: 'button_reply', data: { id: 'ocso:product:sales', title: 'Loa…' }, fallbackText: 'Loa…' }]);
    await f.engine.advance(tap.conversationId, 'r2');
    expect((await f.conversation(tap.conversationId)).agentId).toBe(f.agents.arjun);

    const typed = await f.say(channel, 'hi', '+919800100004');
    await f.engine.advance(typed.conversationId, 'r1');
    await f.say(channel, 'it is about my card please', '+919800100004');
    await f.engine.advance(typed.conversationId, 'r2');
    // "card" is a synonym of Cards & EMI; no rule names cards, so it is the fallback queue with the attribute set.
    expect(await f.routing(typed.conversationId)).toMatchObject({ outcome: 'FALLBACK', attributes: { product: 'cards' } });
  });

  it('messages written while the router waits are consumed once; a repeated route job is a no-op', async () => {
    const { conversationId } = await f.say(channel, 'hi', '+919800100005');
    await f.engine.advance(conversationId, 'r1');
    await f.engine.advance(conversationId, 'r1-again');
    expect(await f.routerMessages(conversationId)).toHaveLength(1);
  });
});

describe('KNOWN and CLASSIFY steps', () => {
  it('a KNOWN attribute skips the question and routes without asking', async () => {
    const channel = await f.channelWith(
      {
        steps: [
          { id: 'lang', kind: 'KNOWN', attribute: 'language', from: 'customer.language' },
          { ...(MENU.steps[0] as Extract<RouterDefinition['steps'][number], { kind: 'ASK' }>), attribute: 'language', skipIfKnown: true },
        ],
        rules: [{ when: { language: ['ta', 'hi'] }, queueId: 'SALES' }],
        fallbackQueueId: 'CARDS',
        returning: null,
        timeoutMinutes: 10,
      },
      'Known',
    );
    const { conversationId } = await f.say(channel, 'vanakkam', '+919800200001');
    const conv = await f.conversation(conversationId);
    await f.t.db.update(customers).set({ language: 'ta' }).where(eq(customers.id, conv.customerId));
    await f.engine.advance(conversationId, 'r1');
    expect(await f.routerMessages(conversationId)).toHaveLength(0);
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun });
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'RULE', attributes: { language: 'ta' } });
  });

  const CLASSIFY: RouterDefinition = {
    steps: [
      {
        id: 'intent',
        kind: 'CLASSIFY',
        attribute: 'product',
        modelProfileId: 'PROFILE',
        instructions: 'Card servicing vs new loans.',
        labels: [
          { value: 'cards', description: 'existing cards, EMI, statements' },
          { value: 'sales', description: 'new loans or cards' },
        ],
        minConfidence: 0.7,
        maxFollowUps: 1,
        skipIfKnown: false,
      },
    ],
    rules: [{ when: { product: 'sales' }, queueId: 'SALES' }],
    fallbackQueueId: 'CARDS',
    returning: null,
    timeoutMinutes: 10,
  };

  it('asks the model; a low-confidence answer asks its follow-up, the reply is classified again', async () => {
    const channel = await f.channelWith(CLASSIFY, 'Classify');
    const calls: string[][] = [];
    const answers = [
      { label: null, confidence: 0.3, followUp: 'Is this about a card you have, or something new?' },
      { label: 'sales', confidence: 0.92, followUp: null },
    ];
    f.classify.impl = async (r) => {
      calls.push(r.transcript.map((m) => `${m.from}: ${m.text}`));
      return answers.shift()!;
    };
    const { conversationId } = await f.say(channel, 'I need some money', '+919800200002');
    await f.engine.advance(conversationId, 'r1');
    const [followUp] = await f.routerMessages(conversationId);
    expect(followUp?.parts).toEqual([{ type: 'TEXT', text: 'Is this about a card you have, or something new?' }]);
    expect((await f.conversation(conversationId)).controlState).toBe('ROUTING');

    await f.say(channel, 'a new personal loan', '+919800200002');
    await f.engine.advance(conversationId, 'r2');
    expect(calls).toEqual([
      ['customer: I need some money'],
      ['customer: I need some money', 'router: Is this about a card you have, or something new?', 'customer: a new personal loan'],
    ]);
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.arjun });
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'MODEL', classifications: { intent: { label: 'sales', confidence: 0.92 } } });
    f.classify.impl = null;
  });

  it('a model failure or an unusable answer leaves the attribute unset: fallback', async () => {
    const channel = await f.channelWith({ ...CLASSIFY, steps: [{ ...(CLASSIFY.steps[0] as Extract<RouterDefinition['steps'][number], { kind: 'CLASSIFY' }>), maxFollowUps: 0 }] }, 'Classify fails');
    f.classify.impl = async () => {
      throw new Error('provider down');
    };
    const { conversationId } = await f.say(channel, 'help', '+919800200003');
    await f.engine.advance(conversationId, 'r1');
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya });
    // Recorded as an outage, not as low confidence.
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'FALLBACK', classifications: { intent: { label: null, confidence: 0, error: 'classifier_error' } } });
    f.classify.impl = null;
  });
});

describe('timeout', () => {
  it('an unanswered question falls back after timeoutMinutes (outcome TIMEOUT)', async () => {
    const channel = await f.channelWith({ ...MENU, timeoutMinutes: 5 }, 'Timeout');
    const { conversationId } = await f.say(channel, 'hi', '+919800300001');
    await f.engine.advance(conversationId, 'r1');
    const before = f.queue.count('conversation.turn', conversationId);
    // Not yet: only 2 minutes waiting.
    await f.t.db.update(conversationRouting).set({ awaitingSince: sql`now() - interval '2 minutes'` }).where(eq(conversationRouting.conversationId, conversationId));
    await f.engine.sweep('sweep-1');
    expect((await f.conversation(conversationId)).controlState).toBe('ROUTING');
    await f.t.db.update(conversationRouting).set({ awaitingSince: sql`now() - interval '6 minutes'` }).where(eq(conversationRouting.conversationId, conversationId));
    const result = await f.engine.sweep('sweep-2');
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, queueId: f.queues.cards });
    expect(await f.routing(conversationId)).toMatchObject({ outcome: 'TIMEOUT', phase: 'DONE' });
    expect(f.queue.count('conversation.turn', conversationId)).toBe(before + 1);
  });

  it('re-signals routing that stalled (lost queue message)', async () => {
    const channel = await f.channelWith(MENU, 'Stalled');
    const { conversationId } = await f.say(channel, 'hi', '+919800300002');
    await f.t.db.update(conversationRouting).set({ updatedAt: sql`now() - interval '5 minutes'` }).where(eq(conversationRouting.conversationId, conversationId));
    const before = f.queue.count('conversation.route', conversationId);
    await f.engine.sweep('sweep-3');
    expect(f.queue.count('conversation.route', conversationId)).toBe(before + 1);
  });
});

describe('one open conversation per customer and channel', () => {
  it('the unique index refuses a second open conversation on the same channel', async () => {
    const channel = await f.channelWith({ steps: [], rules: [], fallbackQueueId: 'CARDS', returning: null, timeoutMinutes: 10 }, 'Unique');
    const { conversationId } = await f.say(channel, 'hi', '+919800400001');
    const conv = await f.conversation(conversationId);
    await expect(
      f.t.db.insert(conversations).values({ id: crypto.randomUUID(), customerId: conv.customerId, channelId: channel, agentId: f.agents.arjun, type: 'SALES', controlState: 'AI_ACTIVE' }),
    ).rejects.toMatchObject({ cause: { constraint: 'conversations_open_channel_uq' } });
  });
});
