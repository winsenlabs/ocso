import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { conversationInsights, conversations, customers, handoffs, interactionParts, interactions, internalNotes, modelProfiles, usageEvents, uuidv7, virtualAgents } from '@ocso/db';
import { SettingsService } from '@ocso/application';
import { ModelGateway, UsageRecorder } from '../src/index.js';
import { ConversationInsightsService, INSIGHTS_METHOD_VERSION, parseInsightOutput } from '../src/jobs/insights.js';
import { createRuntimeHarness, type RuntimeHarness } from './harness.js';

let h: RuntimeHarness;
let service: ConversationInsightsService;
let convId: string;

const OUTPUT = {
  topic: '  Duplicate   EMI debit ',
  outcome: 'ESCALATED',
  escalationReason: 'refund above authority',
  knowledgeGap: null,
  failureTopic: 'EMI refund',
  sentiment: 'NEGATIVE',
  salesOutcome: 'converted',
  turnsBeforeEscalation: 7,
};

async function seedConversation(agentId: string, messages: Array<['CUSTOMER' | 'AGENT' | 'HUMAN', string]>, state = 'RESOLVED') {
  const customerId = uuidv7();
  await h.t.db.insert(customers).values({ id: customerId, displayName: 'Priya Deshmukh' });
  const id = uuidv7();
  const opened = new Date(Date.now() - 3_600_000);
  await h.t.db.insert(conversations).values({ id, customerId, agentId, type: 'SUPPORT', controlState: state, openedAt: opened, lastSeq: messages.length + 1, resolvedAt: new Date() });
  let seq = 0;
  for (const [actorType, text] of messages) {
    seq++;
    const iid = uuidv7();
    await h.t.db.insert(interactions).values({ id: iid, conversationId: id, seq, actorType, direction: actorType === 'CUSTOMER' ? 'INBOUND' : 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'seed', createdAt: new Date(opened.getTime() + seq * 60_000) });
    await h.t.db.insert(interactionParts).values({ id: uuidv7(), interactionId: iid, idx: 0, type: 'TEXT', content: { type: 'TEXT', text } });
  }
  // Internal-only material that must never reach the classifier.
  const sys = uuidv7();
  await h.t.db.insert(interactions).values({ id: sys, conversationId: id, seq: seq + 1, actorType: 'SYSTEM', direction: 'INTERNAL', visibility: 'INTERNAL', kind: 'SYSTEM_EVENT', correlationId: 'seed', createdAt: new Date(opened.getTime() + (seq + 1) * 60_000) });
  await h.t.db.insert(interactionParts).values({ id: uuidv7(), interactionId: sys, idx: 0, type: 'TEXT', content: { type: 'TEXT', text: 'SYSTEM-ONLY-MARKER' } });
  await h.t.db.insert(internalNotes).values({ id: uuidv7(), conversationId: id, authorId: h.lead.principal!.userId, body: 'NOTE-ONLY-MARKER customer is a VIP' });
  return id;
}

beforeAll(async () => {
  h = await createRuntimeHarness();
  const gateway = new ModelGateway(h.t.db, { get: async () => h.adapter }, new UsageRecorder(h.t.db), new SettingsService(h.t.db));
  service = new ConversationInsightsService(h.t.db, gateway);
  convId = await seedConversation(h.agentId, [
    ['CUSTOMER', 'My EMI was debited twice this month'],
    ['AGENT', 'I can see two debits of 4,160'],
    ['CUSTOMER', 'Please refund 12480 now'],
    ['AGENT', 'That is above what I can approve, connecting a colleague'],
    ['HUMAN', 'Hi, Nikhil here, I will process it'],
  ]);
  // Escalation after message 4 (the second agent reply).
  await h.t.db.insert(handoffs).values({
    id: uuidv7(), conversationId: convId, trigger: 'AGENT_DECISION', reasonCode: 'refund_above_authority', reasonText: 'refund above authority',
    requestedByType: 'AGENT', mode: 'OPEN_PICKUP', priority: 'P2', status: 'RESOLVED', requestedAt: new Date(Date.now() - 3_600_000 + 4 * 60_000 + 30_000),
  });
});
afterAll(async () => {
  await h?.t.drop();
});

describe('conversation insights', () => {
  it('classifies the customer-visible transcript with structured output and stores the method', async () => {
    h.adapter.script = [{ text: JSON.stringify(OUTPUT) }];
    const result = await service.analyze(convId, 'test-corr');
    expect(result.status).toBe('stored');
    if (result.status !== 'stored') return;
    expect(result.insight).toMatchObject({
      conversationId: convId,
      agentId: h.agentId,
      topic: 'Duplicate EMI debit',
      outcome: 'ESCALATED',
      escalationReason: 'refund above authority',
      knowledgeGap: null,
      failureTopic: 'EMI refund',
      sentiment: 'NEGATIVE',
      salesOutcome: null, // SUPPORT agent: sales outcomes are not recorded
      turnsBeforeEscalation: 2, // recomputed from data, not the model's 7
      methodVersion: INSIGHTS_METHOD_VERSION,
    });
    expect(INSIGHTS_METHOD_VERSION).toMatch(/^insights\.v1\+[0-9a-f]{10}$/);
    const request = h.adapter.requests.at(-1)!;
    expect(request.purpose).toBe('CLASSIFIER');
    expect(request.responseSchema).toMatchObject({ type: 'object', required: expect.arrayContaining(['topic', 'outcome', 'turnsBeforeEscalation']) });
    const prompt = JSON.stringify(request.messages);
    expect(prompt).toContain('My EMI was debited twice');
    expect(prompt).toContain('Human colleague: Hi, Nikhil here');
    expect(prompt).toContain('Handoff after message 4: trigger AGENT_DECISION, reason \\"refund above authority\\"');
    expect(prompt).not.toContain('SYSTEM-ONLY-MARKER');
    expect(prompt).not.toContain('NOTE-ONLY-MARKER');
    const [usage] = await h.t.db.select().from(usageEvents).where(eq(usageEvents.id, result.insight.usageEventId!));
    expect(usage).toMatchObject({ purpose: 'CLASSIFIER', conversationId: convId, agentId: h.agentId, status: 'OK' });
  });

  it('replaces the derived row on re-analysis and prefers the summarizer profile', async () => {
    const [agent] = await h.t.db.select().from(virtualAgents).where(eq(virtualAgents.id, h.agentId));
    const [primary] = await h.t.db.select().from(modelProfiles).where(eq(modelProfiles.id, agent!.modelProfileId!));
    const summarizer = uuidv7();
    await h.t.db.insert(modelProfiles).values({ id: summarizer, name: 'summarizer', providerId: primary!.providerId, model: 'scripted-small', retries: 0 });
    await h.t.db.update(virtualAgents).set({ summarizerProfileId: summarizer }).where(eq(virtualAgents.id, h.agentId));
    h.adapter.script = [{ text: `Here you go: ${JSON.stringify({ ...OUTPUT, outcome: 'RESOLVED_BY_HUMAN', sentiment: 'POSITIVE' })}` }];
    const result = await service.analyze(convId);
    if (result.status !== 'stored') throw new Error('expected stored');
    expect(result.insight).toMatchObject({ outcome: 'RESOLVED_BY_HUMAN', sentiment: 'POSITIVE' });
    expect(await h.t.db.select().from(conversationInsights).where(eq(conversationInsights.conversationId, convId))).toHaveLength(1);
    const [usage] = await h.t.db.select().from(usageEvents).where(eq(usageEvents.id, result.insight.usageEventId!));
    expect(usage!.profileId).toBe(summarizer);
  });

  it('rejects output that does not match the schema', async () => {
    h.adapter.script = [{ text: JSON.stringify({ ...OUTPUT, outcome: 'GREAT' }) }];
    await expect(service.analyze(convId)).rejects.toMatchObject({ code: 'insights_output_invalid' });
    expect(() => parseInsightOutput(undefined, 'no json here')).toThrow(/insights schema/);
    expect(parseInsightOutput({ ...OUTPUT, knowledgeGap: '   ' }, '').knowledgeGap).toBeNull();
  });

  it('skips conversations it cannot analyze', async () => {
    expect(await service.analyze(uuidv7())).toEqual({ status: 'skipped', reason: 'not_found' });
    const bare = uuidv7();
    await h.t.db.insert(virtualAgents).values({ id: bare, name: 'No Model', slug: 'no-model', conversationType: 'SALES' });
    const conv = await seedConversation(bare, [['CUSTOMER', 'hi']]);
    expect(await service.analyze(conv)).toEqual({ status: 'skipped', reason: 'no_profile' });
  });

  it('records sales outcomes only for SALES agents', async () => {
    const [agent] = await h.t.db.select().from(virtualAgents).where(eq(virtualAgents.id, h.agentId));
    const sales = uuidv7();
    await h.t.db.insert(virtualAgents).values({ id: sales, name: 'Arjun', slug: 'arjun', conversationType: 'SALES', modelProfileId: agent!.modelProfileId });
    const conv = await seedConversation(sales, [['CUSTOMER', 'I want the premium card'], ['AGENT', 'Great, applying now']]);
    h.adapter.script = [{ text: JSON.stringify({ ...OUTPUT, salesOutcome: 'follow up', outcome: 'RESOLVED_BY_AI' }) }];
    const result = await service.analyze(conv);
    if (result.status !== 'stored') throw new Error('expected stored');
    expect(result.insight).toMatchObject({ salesOutcome: 'FOLLOW_UP', turnsBeforeEscalation: null });
  });
});
