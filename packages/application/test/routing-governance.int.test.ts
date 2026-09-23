import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import type { RouterDefinition } from '@ocso/domain';
import { auditEvents, channels, conversations, handoffs, queueTeams, queues, teams, uuidv7, virtualAgents } from '@ocso/db';
import { AgentService, HumanControlService, QueueService, conversationScope, disableRouter, routedQueueBlockers } from '../src/index.js';
import { createRoutingFixture, type RoutingFixture } from './support/routing-fixture.js';

/**
 * Routing under governance (PM/research/11 §4–5, ADR-026): stopping a router
 * never strands customers already talking to someone; routing never hands a
 * customer to an agent that does not answer; queue writes are team-scoped and
 * changes to queues live routing uses are approvals; a returning customer's
 * history stays with their own teams.
 */
let f: RoutingFixture;
const PASS: RouterDefinition = { steps: [], rules: [], fallbackQueueId: 'CARDS', returning: null, timeoutMinutes: 10 };
const MENU: RouterDefinition = {
  steps: [{ id: 'product', kind: 'ASK', attribute: 'product', prompt: { text: 'Which?' }, options: [{ value: 'cards', label: 'Cards', synonyms: [] }, { value: 'sales', label: 'Loans', synonyms: [] }], maxAttempts: 2, skipIfKnown: false }],
  rules: [{ when: { product: 'sales' }, queueId: 'SALES' }],
  fallbackQueueId: 'CARDS',
  returning: null,
  timeoutMinutes: 10,
};
beforeAll(async () => {
  f = await createRoutingFixture();
});
afterAll(async () => {
  await f?.drop();
});

const status = (ids: string[], value: 'LIVE' | 'PAUSED') => f.t.db.update(virtualAgents).set({ status: value }).where(inArray(virtualAgents.id, ids));

describe('a disabled router', () => {
  it('stops new conversations only: customers mid-conversation keep reaching their person; rejections are audited', async () => {
    const channel = await f.channelWith(PASS, 'Disable me');
    const { conversationId } = await f.say(channel, 'I need a person', '+919880000001');
    await new HumanControlService(f.t.db).takeOver(f.actor, conversationId);
    const [row] = await f.t.db.select({ routerId: channels.routerId }).from(channels).where(eq(channels.id, channel));
    await f.t.db.transaction((tx) => disableRouter(tx, f.actor, row!.routerId!));

    const reply = await f.say(channel, 'are you still there?', '+919880000001');
    expect(reply).toMatchObject({ conversationId, created: false });
    expect((await f.conversation(conversationId)).controlState).toBe('HUMAN_ACTIVE');

    const stranger = await f.ingress.receive(
      channel,
      { externalMessageId: 'new-1', identityKind: 'whatsapp_phone', identityValue: '+919880000002', alternateIdentities: [], receivedAt: new Date(), parts: [{ type: 'TEXT', text: 'hello' }] },
      'c-new',
    );
    expect(stranger).toEqual({ status: 'rejected', reason: 'no_router' });
    const [audit] = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'conversation.inbound_rejected'), eq(auditEvents.targetId, channel)));
    expect(audit?.after).toMatchObject({ reason: 'no_router', externalMessageId: 'new-1' });
    expect(JSON.stringify(audit?.after)).not.toContain('hello');
  });
});

describe('agents that do not answer', () => {
  it('routing prefers the fallback whose agent answers; with none, a person takes it at once', async () => {
    const channel = await f.channelWith(MENU, 'Paused');
    await status([f.agents.arjun], 'PAUSED');
    const a = await f.say(channel, 'hi', '+919880000003');
    await f.engine.advance(a.conversationId, 'r1');
    await f.say(channel, 'Loans', '+919880000003');
    await f.engine.advance(a.conversationId, 'r2');
    expect(await f.conversation(a.conversationId)).toMatchObject({ controlState: 'AI_ACTIVE', agentId: f.agents.maya, queueId: f.queues.cards });
    expect(await f.routing(a.conversationId)).toMatchObject({ outcome: 'FALLBACK' });

    await status([f.agents.arjun, f.agents.maya], 'PAUSED');
    const b = await f.say(channel, 'hi', '+919880000004');
    await f.engine.advance(b.conversationId, 'r1');
    await f.say(channel, 'Loans', '+919880000004');
    const turns = f.queue.count('conversation.turn', b.conversationId);
    await f.engine.advance(b.conversationId, 'r2');
    expect(await f.conversation(b.conversationId)).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', agentId: f.agents.arjun, queueId: f.queues.sales });
    const [h] = await f.t.db.select().from(handoffs).where(eq(handoffs.conversationId, b.conversationId));
    expect(h).toMatchObject({ reasonCode: 'agent_unavailable', queueId: f.queues.sales, status: 'WAITING' });
    expect(f.queue.count('conversation.turn', b.conversationId)).toBe(turns);

    // Pass-through does the same for a new customer.
    const pass = await f.channelWith(PASS, 'Paused pass-through');
    const c = await f.say(pass, 'hello', '+919880000005');
    expect(c).toMatchObject({ created: true, turnQueued: false });
    expect(await f.conversation(c.conversationId)).toMatchObject({ controlState: 'WAITING_FOR_HUMAN', agentId: f.agents.maya });
    await status([f.agents.arjun, f.agents.maya], 'LIVE');
  });
});

describe('queue writes', () => {
  const service = () => new QueueService(f.t.db);
  let otherTeam: string;
  let outsider: Principal;
  beforeAll(async () => {
    otherTeam = uuidv7();
    await f.t.db.insert(teams).values({ id: otherTeam, name: 'Collections' });
    outsider = { userId: uuidv7(), role: 'HEAD', displayName: 'Other Head', teamIds: [otherTeam], via: 'UI' };
    await f.t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'other@routing.test', 'Other Head', 'HEAD')`, [outsider.userId]);
    await f.t.db.insert(queueTeams).values([{ queueId: f.queues.cards, teamId: f.lead.teamIds[0]! }]);
    await f.channelWith(PASS, 'Live cards');
  });

  it('are team-scoped: another team’s queue is not found; only your own teams are unlinked', async () => {
    await expect(service().update({ principal: outsider, correlationId: 't' }, f.queues.cards, { name: 'Mine now' })).rejects.toMatchObject({ category: 'not_found' });
    // Another team's link is theirs to remove (the outsider's team staffs a queue the lead's agent serves).
    const shared = await service().create(f.actor, { name: 'Shared queue', description: null, mode: 'OPEN_PICKUP', autoAssignAfterSeconds: null, acceptTimeoutSeconds: 120, requiredSkills: [], languages: [], preferAccountOwner: true, slaPolicyId: null, teamIds: [f.lead.teamIds[0]!, otherTeam], agentId: null, attributes: {}, businessHours: null, transferTargetIds: [] });
    await expect(service().update(f.actor, shared, { teamIds: [f.lead.teamIds[0]!] })).rejects.toMatchObject({ code: 'queue_team_not_yours' });
    const foreign = (await new AgentService(f.t.db).create({ principal: outsider, correlationId: 't' }, { name: 'Kiran', purpose: 'collections', conversationType: 'COLLECTIONS', description: '', teamIds: [otherTeam] })).id;
    const q = await service().create(f.actor, { name: 'Draft queue', description: null, mode: 'OPEN_PICKUP', autoAssignAfterSeconds: null, acceptTimeoutSeconds: 120, requiredSkills: [], languages: [], preferAccountOwner: true, slaPolicyId: null, teamIds: [f.lead.teamIds[0]!], agentId: null, attributes: {}, businessHours: null, transferTargetIds: [] });
    await expect(service().update(f.actor, q, { agentId: foreign })).rejects.toMatchObject({ category: 'not_found' });
    // A queue nothing routes to yet is a draft: free to edit.
    await service().update(f.actor, q, { agentId: f.agents.arjun, transferTargetIds: [f.queues.sales] });
  });

  it('every change to a queue live routing uses is an approval (wave 2: the queue descriptor); stops stay direct', async () => {
    await expect(service().update(f.actor, f.queues.cards, { agentId: f.agents.arjun })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'queue', objectId: f.queues.cards, action: 'UPDATE' } });
    await expect(service().update(f.actor, f.queues.cards, { agentId: null })).rejects.toMatchObject({ code: 'approval_required' });
    await expect(service().update(f.actor, f.queues.cards, { acceptTimeoutSeconds: 90 })).rejects.toMatchObject({ code: 'approval_required' });
    // Removing a transfer target is a stop: applied at once.
    await f.t.db.update(queues).set({ transferTargetIds: [f.queues.sales] }).where(eq(queues.id, f.queues.cards));
    await service().update(f.actor, f.queues.cards, { transferTargetIds: [] });
    const [row] = await f.t.db.select({ agentId: queues.agentId, accept: queues.acceptTimeoutSeconds, targets: queues.transferTargetIds }).from(queues).where(eq(queues.id, f.queues.cards));
    expect(row).toEqual({ agentId: f.agents.maya, accept: 120, targets: [] });
    // Deleting the agent a routed queue depends on is blocked too.
    expect((await routedQueueBlockers(f.t.db, f.agents.maya)).map((p) => p.code)).toContain('agent_serves_routed_queue');
  });
});

describe('who sees a conversation while a router decides', () => {
  it('a returning customer’s conversation stays with its own teams; router-opened ones are shown to reachable Leads', async () => {
    const salesTeam = uuidv7();
    await f.t.db.insert(teams).values({ id: salesTeam, name: 'Sales team' });
    await f.t.db.insert(queueTeams).values({ queueId: f.queues.sales, teamId: salesTeam });
    const salesLead: Principal = { userId: uuidv7(), role: 'LEAD', displayName: 'Sales Lead', teamIds: [salesTeam], via: 'UI' };
    const visible = async (id: string) =>
      (await f.t.db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.id, id), conversationScope(salesLead, { execsCanViewAiActive: true })!))).length === 1;

    const channel = await f.channelWith({ ...MENU, returning: { askAfter: { value: 1, unit: 'HOURS' }, prompt: { text: 'Back?' }, continueLabel: 'Continue', newLabel: 'New' } }, 'Visibility');
    const fresh = await f.say(channel, 'hi', '+919880000006');
    expect(await visible(fresh.conversationId)).toBe(true);

    // An earlier Cards conversation (Maya), its customer back after the gap: asked continue-or-new, in ROUTING.
    f.now.value = new Date(Date.now() - 3 * 3_600_000);
    const old = await f.say(channel, 'my card', '+919880000007');
    await f.engine.advance(old.conversationId, 'r1');
    await f.say(channel, 'Cards', '+919880000007');
    await f.engine.advance(old.conversationId, 'r2');
    f.now.value = new Date();
    await f.say(channel, 'hello again', '+919880000007');
    expect(await f.conversation(old.conversationId)).toMatchObject({ controlState: 'ROUTING', agentId: f.agents.maya });
    expect(await visible(old.conversationId)).toBe(false);
  });
});
