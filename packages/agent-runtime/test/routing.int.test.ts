import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { channels, conversationRouting, conversations, queues, toolCalls, turns, uuidv7, virtualAgents } from '@ocso/db';
import { AgentService, IngressService, QueueService, RoutingEngine, createActiveRouter, systemActor } from '@ocso/application';
import { MemoryQueue } from '@ocso/queue';
import { createLogger } from '@ocso/observability';
import { ModelGateway, RouteProcessor, TRANSFER_TOOL, UsageRecorder, createRouterClassifier } from '../src/index.js';
import { SettingsService } from '@ocso/application';
import { createRuntimeHarness, turnMessage, type RuntimeHarness } from './harness.js';

/**
 * Routing in the runtime (PM/research/11 §5.3, §5.5): CLASSIFY through the
 * model gateway with the scripted provider, the conversation.route consumer,
 * and AI queue transfers where the receiving agent continues at once.
 */
let h: RuntimeHarness;
let arjun: string;
let salesQueue: string;
let profileId: string;

beforeAll(async () => {
  h = await createRuntimeHarness();
  const [maya] = await h.t.db.select().from(virtualAgents).where(eq(virtualAgents.id, h.agentId));
  profileId = maya!.modelProfileId!;
  const team = h.lead.principal!.teamIds[0]!;
  arjun = (await new AgentService(h.t.db).create(h.lead, { name: 'Arjun', purpose: 'loan sales', conversationType: 'SALES', description: '', modelProfileId: profileId, teamIds: [team] })).id;
  await h.t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, arjun));
  salesQueue = uuidv7();
  await h.t.db.insert(queues).values({ id: salesQueue, name: 'Sales', agentId: arjun, attributes: { product: 'sales' } });
});
afterAll(async () => {
  await h?.t.drop();
});
beforeEach(async () => {
  h.adapter.script = [];
  h.adapter.requests = [];
  await h.t.pool.query(`UPDATE conversations SET control_state = 'RESOLVED', resolved_at = now() - interval '10 days' WHERE control_state <> 'RESOLVED'`);
  await h.t.pool.query('DELETE FROM conversation_leases');
});

describe('CLASSIFY with the scripted provider', () => {
  let channelId: string;
  let ingress: IngressService;
  let engine: RoutingEngine;
  const queue = new MemoryQueue();
  const say = async (text: string, phone: string) => {
    const r = await ingress.receive(channelId, { externalMessageId: uuidv7(), identityKind: 'whatsapp_phone', identityValue: phone, alternateIdentities: [], receivedAt: new Date(), parts: [{ type: 'TEXT', text }] }, 't');
    if (r.status !== 'accepted') throw new Error(r.status);
    return r.conversationId;
  };

  beforeAll(async () => {
    channelId = uuidv7();
    await h.t.db.insert(channels).values({ id: channelId, kind: 'WHATSAPP', name: 'Classified', status: 'ACTIVE', publicKey: `pk-${channelId.slice(-8)}` });
    await createActiveRouter(h.t.db, systemActor('test', 't'), {
      name: 'Classifier',
      channelIds: [channelId],
      definition: {
        steps: [
          {
            id: 'intent',
            kind: 'CLASSIFY',
            attribute: 'product',
            modelProfileId: profileId,
            instructions: 'Existing card servicing vs new loans.',
            labels: [
              { value: 'cards', description: 'existing cards and EMIs' },
              { value: 'sales', description: 'new loans and cards' },
            ],
            minConfidence: 0.7,
            maxFollowUps: 1,
            skipIfKnown: false,
          },
        ],
        rules: [{ when: { product: 'sales' }, queueId: salesQueue }],
        fallbackQueueId: h.queueId,
        returning: null,
        timeoutMinutes: 10,
      },
    });
    ingress = new IngressService(h.t.db, queue);
    const gateway = new ModelGateway(h.t.db, { get: async () => h.adapter }, new UsageRecorder(h.t.db), new SettingsService(h.t.db));
    engine = new RoutingEngine({ db: h.t.db, queue, classifier: createRouterClassifier(gateway) });
  });

  it('asks the follow-up the model suggests, then routes on the confident answer (structured output, CLASSIFIER usage)', async () => {
    h.adapter.script = [
      { text: JSON.stringify({ label: null, confidence: 0.35, followUp: 'Is this about a card you already have, or a new loan?' }) },
      { text: '```json\n{"label":"sales","confidence":0.93,"followUp":null}\n```' },
    ];
    const id = await say('I need money for a wedding', '+919833000001');
    await engine.advance(id, 'r1');
    const request = h.adapter.requests[0]!;
    expect(request.purpose).toBe('CLASSIFIER');
    expect(request.responseSchema).toMatchObject({ required: ['label', 'confidence', 'followUp'] });
    expect(request.system[0]!.text).toContain('- sales: new loans and cards');
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, id));
    expect(conv).toMatchObject({ controlState: 'ROUTING', agentId: null });

    await say('a new personal loan', '+919833000001');
    await engine.advance(id, 'r2');
    expect(JSON.stringify(h.adapter.requests[1]!.messages)).toContain('Menu: Is this about a card you already have, or a new loan?');
    const [routed] = await h.t.db.select().from(conversations).where(eq(conversations.id, id));
    expect(routed).toMatchObject({ controlState: 'AI_ACTIVE', agentId: arjun, queueId: salesQueue });
    const [row] = await h.t.db.select().from(conversationRouting).where(eq(conversationRouting.conversationId, id));
    expect(row).toMatchObject({ outcome: 'MODEL', attributes: { product: 'sales' } });
  });

  it('an unparseable model answer is unclassified: the fallback queue', async () => {
    h.adapter.script = [{ text: 'I think it is about loans' }, { text: 'still not JSON' }];
    const id = await say('hmm', '+919833000002');
    await engine.advance(id, 'r1');
    const [routed] = await h.t.db.select().from(conversations).where(eq(conversations.id, id));
    expect(routed).toMatchObject({ controlState: 'AI_ACTIVE', agentId: h.agentId, queueId: h.queueId });
  });

  it('the route consumer only advances ROUTING conversations', async () => {
    h.adapter.script = [{ text: JSON.stringify({ label: 'cards', confidence: 0.99, followUp: null }) }];
    const processor = new RouteProcessor({ db: h.t.db, engine, logger: createLogger({ service: 'test', version: '0', level: 'fatal' }) });
    const id = await say('my card', '+919833000003');
    const message = { id: uuidv7(), topic: 'conversation.route' as const, payload: { conversationId: id }, groupKey: id, attempt: 1, enqueuedAt: new Date() };
    expect(await processor.handle(message)).toEqual({ kind: 'ack' });
    expect((await h.t.db.select().from(conversations).where(eq(conversations.id, id)))[0]).toMatchObject({ controlState: 'AI_ACTIVE', agentId: h.agentId });
    // Again (a duplicate delivery): nothing to do.
    expect(await processor.handle(message)).toEqual({ kind: 'ack' });
    expect(h.adapter.requests).toHaveLength(1);
  });
});

/** What an approved queue change applies: live queues change only through approval (the queue descriptor is wave 2). */
const approveTargets = (queueId: string, targets: string[]) => h.t.db.update(queues).set({ transferTargetIds: targets }).where(eq(queues.id, queueId));

describe('AI transfer to another queue', () => {
  it('Maya transfers to Sales; Arjun continues in the same drain with the handover and no way back', async () => {
    await approveTargets(h.queueId, [salesQueue]);
    h.adapter.script = [
      { toolCalls: [{ toolName: TRANSFER_TOOL, input: { queue: 'Sales', reason: 'personal loan enquiry', summary: 'Customer wants a personal loan quote for ₹3 lakh.' } }] },
      { text: 'I’ll pass you to Arjun from our loans team.' },
      { text: 'Hi, Arjun here — happy to help with your personal loan.' },
    ];
    const conversationId = await h.say('I want a personal loan of 3 lakh');
    const { processor } = h.processor('w-transfer');
    expect(await processor.handle(turnMessage(conversationId))).toEqual({ kind: 'ack' });

    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ controlState: 'AI_ACTIVE', agentId: arjun, queueId: salesQueue });
    const done = await h.t.db.select({ agentId: turns.agentId, outcome: turns.outcome }).from(turns).where(eq(turns.conversationId, conversationId)).orderBy(asc(turns.startedAt));
    expect(done).toEqual([
      { agentId: h.agentId, outcome: 'TRANSFERRED' },
      { agentId: arjun, outcome: 'REPLIED' },
    ]);
    // Maya saw the tool with exactly her queue's targets; Arjun (Sales has none) does not have it.
    const mayaTool = h.adapter.requests[0]!.tools.find((t) => t.name === TRANSFER_TOOL);
    expect(mayaTool?.inputSchema).toMatchObject({ properties: { queue: { enum: ['Sales'] } } });
    const arjunRequest = h.adapter.requests[2]!;
    expect(arjunRequest.tools.some((t) => t.name === TRANSFER_TOOL)).toBe(false);
    const handover = arjunRequest.system.find((b) => b.key === 'handover');
    expect(handover?.text).toContain('Transferred to you from Maya (Cards & EMI · Tier 2). Reason: personal loan enquiry');
    expect(arjunRequest.system.find((b) => b.key === 'routing')?.text).toContain('Queue: Sales');
    // Arjun answers the customer's message himself.
    expect(JSON.stringify(arjunRequest.messages)).toContain('I want a personal loan of 3 lakh');
    const [call] = await h.t.db.select().from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.toolName, TRANSFER_TOOL)));
    expect(call?.status).toBe('SUCCEEDED');
  });

  it('the receiving agent cannot bounce the conversation straight back', async () => {
    await approveTargets(salesQueue, [h.queueId]);
    h.adapter.script = [
      { toolCalls: [{ toolName: TRANSFER_TOOL, input: { queue: 'Sales', reason: 'loans', summary: 'wants a loan' } }] },
      { text: 'Passing you to our loans team.' },
      { toolCalls: [{ toolName: TRANSFER_TOOL, input: { queue: 'Cards & EMI · Tier 2', reason: 'back', summary: 'back' } }] },
      { text: 'Sure, I can help with the loan myself.' },
    ];
    const conversationId = await h.say('loan please');
    await h.processor('w-bounce').processor.handle(turnMessage(conversationId));
    const [conv] = await h.t.db.select().from(conversations).where(eq(conversations.id, conversationId));
    expect(conv).toMatchObject({ agentId: arjun, queueId: salesQueue });
    const calls = await h.t.db.select({ status: toolCalls.status, error: toolCalls.errorMessage }).from(toolCalls).where(and(eq(toolCalls.conversationId, conversationId), eq(toolCalls.toolName, TRANSFER_TOOL))).orderBy(asc(toolCalls.id));
    expect(calls.map((c) => c.status)).toEqual(['SUCCEEDED', 'FAILED']);
    expect(calls[1]!.error).toContain('just transferred to you');
    // Removing a transfer target is a stop: direct, never gated.
    await new QueueService(h.t.db).update(h.lead, salesQueue, { transferTargetIds: [] });
  });
});
