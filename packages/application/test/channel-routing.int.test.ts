import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { channels, conversations, modelProfiles, modelProviders, queues, routers, teams, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import type { Principal } from '@ocso/auth';
import {
  AgentService,
  ChannelService,
  IngressService,
  RouterService,
  createActiveRouter,
  disableRouter,
  manageableChannelsSql,
  reachForAgents,
  routeChannelToAgent,
  type ActorContext,
  type IngressMessage,
} from '../src/index.js';

/**
 * Which agent answers a channel (PM/research/11 §5): channel → router →
 * queue → agent. Channels no longer name an agent; what an agent is "reached
 * through" is derived from active routers and the queues it serves.
 */
let t: TestDatabase;
const queue = new MemoryQueue();
const TEAM = uuidv7();
const lead: Principal = { userId: '00000000-0000-7000-8000-0000000000b1', role: 'HEAD', displayName: 'Anjali Rao', teamIds: [TEAM], via: 'UI' };
const other: Principal = { userId: '00000000-0000-7000-8000-0000000000b2', role: 'HEAD', displayName: 'Other Lead', teamIds: [uuidv7()], via: 'UI' };
const ctx: ActorContext = { principal: lead, correlationId: 'test' };
let maya: string;
let ava: string;
let mayaQueue: string;
let avaQueue: string;
const msg = (id: string, phone: string): IngressMessage => ({
  externalMessageId: id,
  identityKind: 'whatsapp_phone',
  identityValue: phone,
  alternateIdentities: [],
  profileName: 'Priya',
  receivedAt: new Date(),
  parts: [{ type: 'TEXT', text: 'hello' }],
});
const channel = async (name: string) => {
  const id = uuidv7();
  await t.db.insert(channels).values({ id, kind: 'WHATSAPP', name, status: 'ACTIVE', publicKey: `pk-${name}` });
  return id;
};
const views = () => new ChannelService(t.db, {} as never, () => [], () => ({ webhookPath: null, embedPath: null }));

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'lead@routing.test', 'Anjali Rao', 'HEAD')`, [lead.userId]);
  await t.db.insert(teams).values({ id: TEAM, name: 'Cards' });
  const service = new AgentService(t.db);
  maya = (await service.create(ctx, { name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM] })).id;
  ava = (await service.create(ctx, { name: 'Ava', purpose: 'sales', conversationType: 'SALES', description: '', teamIds: [TEAM] })).id;
  // Live agents with a model: the agents that answer (routing hands customers of any other to a person).
  const providerId = uuidv7();
  const profileId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted', residencyZone: 'IN' });
  await t.db.insert(modelProfiles).values({ id: profileId, name: 'answers', providerId, model: 'scripted' });
  await t.db.update(virtualAgents).set({ status: 'LIVE', modelProfileId: profileId });
  [mayaQueue, avaQueue] = [uuidv7(), uuidv7()];
  await t.db.insert(queues).values([
    { id: mayaQueue, name: 'Cards', agentId: maya },
    { id: avaQueue, name: 'Sales', agentId: ava },
  ]);
});
afterAll(async () => {
  await t?.drop();
});

describe('channel routing', () => {
  it('a channel with an active pass-through router answers as its queue’s agent', async () => {
    const id = await channel('routed');
    await routeChannelToAgent(t.db, ctx, { channelId: id, agentId: maya, queueId: mayaQueue, name: 'Routed' });
    const accepted = await new IngressService(t.db, queue).receive(id, msg('wamid.route.1', '+919800000001'), 'c1');
    expect(accepted).toMatchObject({ status: 'accepted', created: true, turnQueued: true, routeQueued: false });
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.channelId, id));
    expect(conv).toMatchObject({ agentId: maya, queueId: mayaQueue, controlState: 'AI_ACTIVE', type: 'SUPPORT' });
    const [view] = (await views().list()).filter((c) => c.id === id);
    expect(view).toMatchObject({ router: { name: 'Routed', status: 'ACTIVE' }, defaultAgentId: maya });
  });

  it('a channel without a router, or with a disabled one, rejects messages as no_router', async () => {
    const rejections: string[] = [];
    const ingress = new IngressService(t.db, queue, { reopenWindowHours: 72, onRejected: (r) => rejections.push(r.detail) });
    const orphan = await channel('orphan');
    expect(await ingress.receive(orphan, msg('wamid.route.2', '+919800000002'), 'c2')).toMatchObject({ status: 'rejected', reason: 'no_router' });
    expect(rejections).toEqual(['channel orphan has no active router']);

    const id = await channel('stopped');
    const { routerId } = await routeChannelToAgent(t.db, ctx, { channelId: id, agentId: maya, queueId: mayaQueue, name: 'Stopped' });
    await t.db.transaction((tx) => disableRouter(tx, ctx, routerId));
    expect(await ingress.receive(id, msg('wamid.route.3', '+919800000003'), 'c3')).toMatchObject({ status: 'rejected', reason: 'no_router' });
    const [row] = await t.db.select({ status: routers.status }).from(routers).where(eq(routers.id, routerId));
    expect(row?.status).toBe('DISABLED');
  });

  it('setting channels on an agent is refused: channels reach agents through routers', async () => {
    const id = await channel('direct');
    await expect(new AgentService(t.db).update(ctx, maya, { channelIds: [id] })).rejects.toMatchObject({ code: 'channels_route_through_routers' });
    await expect(new AgentService(t.db).create(ctx, { name: 'Noa', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM], channelIds: [id] })).rejects.toMatchObject({
      code: 'channels_route_through_routers',
    });
    const [row] = await t.db.select({ defaultAgentId: channels.defaultAgentId }).from(channels).where(eq(channels.id, id));
    expect(row?.defaultAgentId).toBeNull();
  });

  it('an agent is reached through every channel whose router can route to its queues', async () => {
    const [a, b] = [await channel('menu-a'), await channel('menu-b')];
    // A menu: product=sales → Ava's queue, otherwise Maya's.
    await createActiveRouter(t.db, ctx, {
      name: 'Menu',
      channelIds: [a, b],
      definition: {
        steps: [{ id: 'p', kind: 'ASK', attribute: 'product', prompt: { text: 'Which?' }, options: [{ value: 'cards', label: 'Cards' }, { value: 'sales', label: 'Sales' }], maxAttempts: 2, skipIfKnown: false }],
        rules: [{ when: { product: 'sales' }, queueId: avaQueue }],
        fallbackQueueId: mayaQueue,
        returning: null,
        timeoutMinutes: 10,
      },
    });
    const reach = await reachForAgents(t.db, [ava]);
    expect(reach.map((r) => r.channelId).sort()).toEqual([a, b].sort());
    expect((await new AgentService(t.db).get(lead, ava)).channelIds.sort()).toEqual([a, b].sort());
    // A router that asks first has no single agent: no derived default.
    const [view] = (await views().list()).filter((c) => c.id === a);
    expect(view?.defaultAgentId).toBeNull();
  });

  it('template access follows reach: a lead manages channels that reach their team’s agents only', async () => {
    const id = await channel('templates');
    await routeChannelToAgent(t.db, ctx, { channelId: id, agentId: maya, queueId: mayaQueue, name: 'Templates' });
    const visible = async (principal: Principal) => {
      const scope = manageableChannelsSql(principal);
      return (await t.db.select({ id: channels.id }).from(channels).where(scope ?? undefined)).map((c) => c.id);
    };
    expect(await visible(lead)).toContain(id);
    expect(await visible(other)).not.toContain(id);
  });

  it('router names are unique (case-insensitive) and routers.manage is required', async () => {
    const service = new RouterService(t.db);
    const definition = { steps: [], rules: [], fallbackQueueId: mayaQueue, returning: null, timeoutMinutes: 10 };
    await service.create(ctx, { name: 'Unique', description: '', definition });
    await expect(service.create(ctx, { name: 'unique', description: '', definition })).rejects.toMatchObject({ code: 'router_name_taken' });
    await expect(service.create({ principal: { ...lead, role: 'SERVICE' }, correlationId: 't' }, { name: 'X', description: '', definition })).rejects.toMatchObject({ category: 'authorization' });
  });
});
