import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { conversationSummaries, handoffs, queues, uuidv7 } from '@ocso/db';
import { HumanControlService, QueueService, agentActor, aiTransferTargets, aiTransferToQueue, requestHandoff, systemActor } from '../src/index.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * Queues as the service unit (PM/research/11 §5.5): one agent per queue,
 * unique attributes, explicit transfer targets, hours on the queue, and
 * transfers between queues that swap the agent.
 */
let f: RoutingFixture;
let channel: string;
beforeAll(async () => {
  f = await createRoutingFixture();
  channel = await f.channelWith({ steps: [], rules: [], fallbackQueueId: 'CARDS', returning: null, timeoutMinutes: 10 }, 'Transfers');
});
afterAll(async () => {
  await f?.drop();
});

const escalate = (conversationId: string) =>
  f.t.db.transaction((tx) =>
    requestHandoff(tx, systemActor('test', 't'), conversationId, { trigger: 'CUSTOMER_REQUEST', reasonCode: 'x', reasonText: 'wants a person', requestedBy: { type: 'CUSTOMER', id: null } }, new Date()),
  );

/** What an approved queue change applies (the queue approval descriptor is wave 2). */
const approveTargets = (queueId: string, targets: string[]) => f.t.db.update(queues).set({ transferTargetIds: targets }).where(eq(queues.id, queueId));

describe('queues', () => {
  const service = () => new QueueService(f.t.db);

  it('attributes are unique across queues (case-insensitive) and one agent serves a queue', async () => {
    const id = await service().create(f.actor, { name: 'Tamil Sales', description: null, mode: 'OPEN_PICKUP', autoAssignAfterSeconds: null, acceptTimeoutSeconds: 120, requiredSkills: [], languages: [], preferAccountOwner: true, slaPolicyId: null, teamIds: [], agentId: f.agents.arjun, attributes: { language: 'TA', product: 'sales' }, businessHours: null, transferTargetIds: [] });
    const [row] = await f.t.db.select().from(queues).where(eq(queues.id, id));
    expect(row).toMatchObject({ agentId: f.agents.arjun, attributes: { language: 'ta', product: 'sales' } });
    await expect(
      service().create(f.actor, { name: 'Duplicate', description: null, mode: 'OPEN_PICKUP', autoAssignAfterSeconds: null, acceptTimeoutSeconds: 120, requiredSkills: [], languages: [], preferAccountOwner: true, slaPolicyId: null, teamIds: [], agentId: null, attributes: { product: 'sales', language: 'ta' }, businessHours: null, transferTargetIds: [] }),
    ).rejects.toMatchObject({ code: 'queue_attributes_taken' });
    // Replacing the agent: still exactly one.
    await service().update(f.actor, id, { agentId: f.agents.maya });
    const [after] = await f.t.db.select({ agentId: queues.agentId }).from(queues).where(eq(queues.id, id));
    expect(after?.agentId).toBe(f.agents.maya);
    const listed = (await service().list()).find((q) => q.id === id);
    expect(listed).toMatchObject({ agentId: f.agents.maya, transferTargetIds: [] });
  });

  it('transfer targets must exist and cannot be the queue itself', async () => {
    await expect(service().update(f.actor, f.queues.cards, { transferTargetIds: [f.queues.cards] })).rejects.toMatchObject({ code: 'transfer_target_self' });
    await expect(service().update(f.actor, f.queues.cards, { transferTargetIds: [uuidv7()] })).rejects.toMatchObject({ category: 'not_found' });
    // Cards is live (a router routes to it): a new transfer target changes where customers go — an approval.
    await expect(service().update(f.actor, f.queues.cards, { transferTargetIds: [f.queues.sales] })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'queue', objectId: f.queues.cards } });
    await approveTargets(f.queues.cards, [f.queues.sales]);
    expect((await aiTransferTargets(f.t.db, f.queues.cards)).map((t) => t.agentName)).toEqual(['Arjun']);
    // The agent already holding the conversation is never a target (it would leave the messages unanswered).
    expect(await aiTransferTargets(f.t.db, f.queues.cards, f.agents.arjun)).toEqual([]);
    // Removing a target is a stop: never gated.
    await service().update(f.actor, f.queues.cards, { transferTargetIds: [] });
    expect(await aiTransferTargets(f.t.db, f.queues.cards)).toEqual([]);
  });

  it('handoffs use the queue’s business hours before the agent’s', async () => {
    // Humans of the Cards queue work Sunday 00:00–00:01 only (closed now, whatever the day).
    await service().update(f.actor, f.queues.cards, { businessHours: { timezone: 'UTC', humanHours: { sun: ['00:00', '00:01'] } } });
    const { conversationId } = await f.say(channel, 'I want a person', '+919822000001');
    const outcome = await escalate(conversationId);
    const [h] = await f.t.db.select().from(handoffs).where(eq(handoffs.id, outcome.handoffId));
    expect(h?.queueId).toBe(f.queues.cards);
    expect((await f.systemEvents(conversationId, 'system.control_changed')).some((t) => t.includes('outside human hours'))).toBe(true);
    await service().update(f.actor, f.queues.cards, { businessHours: null });
  });
});

describe('transfers', () => {
  it('a human transfer of a waiting conversation to another queue swaps in that queue’s agent and keeps it waiting', async () => {
    const { conversationId } = await f.say(channel, 'need a human', '+919822000002');
    await escalate(conversationId);
    await new HumanControlService(f.t.db).transfer(f.actor, conversationId, { queueId: f.queues.sales });
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: f.queues.sales, agentId: f.agents.arjun });
    expect((await f.systemEvents(conversationId, 'system.control_changed')).at(-1)).toContain('transferred by Anjali Rao to Sales · agent Arjun');
  });

  it('a held conversation transferred to another queue waits again there, with its agent', async () => {
    const { conversationId } = await f.say(channel, 'hello', '+919822000003');
    await new HumanControlService(f.t.db).takeOver(f.actor, conversationId);
    await new HumanControlService(f.t.db).transfer(f.actor, conversationId, { queueId: f.queues.sales });
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', queueId: f.queues.sales, agentId: f.agents.arjun, assignedUserId: null });
  });

  it('an AI transfer moves the conversation to an allowed target, with a handover summary, staying AI_ACTIVE', async () => {
    await approveTargets(f.queues.cards, [f.queues.sales]);
    const { conversationId } = await f.say(channel, 'I want a new loan', '+919822000004');
    const before = await f.conversation(conversationId);
    await f.t.db.transaction((tx) => aiTransferToQueue(tx, agentActor(f.agents.maya, 't', 'Maya'), conversationId, { queueId: f.queues.sales, reason: 'loan enquiry', summary: 'Customer wants a personal loan quote.', now: new Date() }));
    expect(await f.conversation(conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', queueId: f.queues.sales, agentId: f.agents.arjun, lastProcessedSeq: before.lastProcessedSeq });
    const [summary] = await f.t.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.conversationId, conversationId), eq(conversationSummaries.kind, 'HANDOVER')))
      .orderBy(desc(conversationSummaries.version));
    expect(summary?.text).toBe('Transferred to you from Maya (Cards). Reason: loan enquiry\nCustomer wants a personal loan quote.');
    // Sales has no transfer targets: the new agent cannot bounce it back.
    await expect(
      f.t.db.transaction((tx) => aiTransferToQueue(tx, agentActor(f.agents.arjun, 't', 'Arjun'), conversationId, { queueId: f.queues.cards, reason: 'back', summary: 'back', now: new Date() })),
    ).rejects.toMatchObject({ code: 'transfer_target_not_allowed' });
  });
});
