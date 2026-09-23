import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { agentChannels, channels, conversations, teams, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import type { Principal } from '@ocso/auth';
import { AgentService, IngressService, type ActorContext, type IngressMessage } from '../src/index.js';

/**
 * Which agent answers a channel. New conversations go to the channel's default
 * agent; a channel without one used to reject every customer message
 * (`no_agent`) even when an agent had it attached.
 */
let t: TestDatabase;
const queue = new MemoryQueue();
const TEAM = uuidv7();
const lead: Principal = { userId: '00000000-0000-7000-8000-0000000000b1', role: 'HEAD', displayName: 'Anjali Rao', teamIds: [TEAM], via: 'UI' };
const ctx: ActorContext = { principal: lead, correlationId: 'test' };
let maya: string;
let ava: string;
const msg = (id: string, phone: string): IngressMessage => ({
  externalMessageId: id,
  identityKind: 'whatsapp_phone',
  identityValue: phone,
  alternateIdentities: [],
  profileName: 'Priya',
  receivedAt: new Date(),
  parts: [{ type: 'TEXT', text: 'hello' }],
});
const channel = async (name: string, defaultAgentId: string | null = null) => {
  const id = uuidv7();
  await t.db.insert(channels).values({ id, kind: 'WHATSAPP', name, status: 'ACTIVE', publicKey: `pk-${name}`, defaultAgentId });
  return id;
};
const defaultOf = async (id: string) => (await t.db.select({ d: channels.defaultAgentId }).from(channels).where(eq(channels.id, id)))[0]!.d;
const attachedTo = async (id: string) => (await t.db.select({ a: agentChannels.agentId }).from(agentChannels).where(eq(agentChannels.channelId, id))).map((r) => r.a);

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'lead@routing.test', 'Anjali Rao', 'HEAD')`, [lead.userId]);
  await t.db.insert(teams).values({ id: TEAM, name: 'Cards' });
  const service = new AgentService(t.db);
  maya = (await service.create(ctx, { name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM] })).id;
  ava = (await service.create(ctx, { name: 'Ava', purpose: 'sales', conversationType: 'SALES', description: '', teamIds: [TEAM] })).id;
  await t.db.update(virtualAgents).set({ status: 'LIVE' });
});
afterAll(async () => {
  await t?.drop();
});

describe('channel routing', () => {
  it('attaching an agent to a channel with no agent makes it the one that answers', async () => {
    const id = await channel('unrouted');
    await new AgentService(t.db).update(ctx, maya, { channelIds: [id] });
    expect(await defaultOf(id)).toBe(maya);
    const { rows } = await t.pool.query(`SELECT summary FROM audit_events WHERE action = 'channel.update' AND target_id = $1`, [id]);
    expect(rows).toHaveLength(1);
  });

  it('a channel answers as one agent: a second agent is refused until it is released', async () => {
    const id = await channel('contested');
    await new AgentService(t.db).update(ctx, maya, { channelIds: [id] });
    await expect(new AgentService(t.db).update(ctx, ava, { channelIds: [id] })).rejects.toMatchObject({ category: 'conflict', code: 'channel_in_use' });
    expect(await defaultOf(id)).toBe(maya);
    expect(await attachedTo(id)).toEqual([maya]);
    // Released by its current agent, the channel is free and stops routing to Maya.
    await new AgentService(t.db).update(ctx, maya, { channelIds: [] });
    expect(await defaultOf(id)).toBeNull();
    await new AgentService(t.db).update(ctx, ava, { channelIds: [id] });
    expect(await defaultOf(id)).toBe(ava);
    expect(await attachedTo(id)).toEqual([ava]);
  });

  it('an agent answers on many channels', async () => {
    const [a, b] = [await channel('many-a'), await channel('many-b')];
    await new AgentService(t.db).update(ctx, maya, { channelIds: [a, b] });
    expect([await defaultOf(a), await defaultOf(b)]).toEqual([maya, maya]);
  });

  it('a new agent created with a channel claims it when the channel has no default', async () => {
    const id = await channel('fresh');
    const noa = (await new AgentService(t.db).create(ctx, { name: 'Noa', purpose: 'support', conversationType: 'SUPPORT', description: '', teamIds: [TEAM], channelIds: [id] })).id;
    expect(await defaultOf(id)).toBe(noa);
  });

  it('without a default agent, a channel attached to exactly one agent still routes to it', async () => {
    const id = await channel('legacy');
    await t.db.insert(agentChannels).values({ agentId: maya, channelId: id });
    const ingress = new IngressService(t.db, queue);
    const accepted = await ingress.receive(id, msg('wamid.route.1', '+919800000001'), 'c1');
    expect(accepted.status).toBe('accepted');
    const [conv] = await t.db.select({ agentId: conversations.agentId }).from(conversations).where(eq(conversations.channelId, id));
    expect(conv?.agentId).toBe(maya);
    // A channel nobody answers on is rejected, with the reason.
    const orphan = await channel('orphan');
    const rejected = await ingress.receive(orphan, msg('wamid.route.2', '+919800000002'), 'c2');
    expect(rejected).toMatchObject({ status: 'rejected', reason: 'no_agent' });
  });
});
