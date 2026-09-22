import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { channels, conversations, customers, queueTeams, queues, teams, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import type { Principal } from '@ocso/auth';
import {
  AgentService,
  InboxService,
  IngressService,
  addNote,
  applyControl,
  loadConversationDetail,
  loadTimeline,
  type ActorContext,
  type IngressMessage,
} from '../src/index.js';

let t: TestDatabase;
const queue = new MemoryQueue();
let channelId: string;
let queueId: string;
let teamId: string;
const lead: Principal = { userId: '00000000-0000-7000-8000-00000000000a', role: 'CS_LEAD', displayName: 'Anjali Rao', teamIds: [], via: 'UI' };
const ctx = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'test' });
const msg = (id: string, text: string, phone = '+919812341208'): IngressMessage => ({
  externalMessageId: id,
  identityKind: 'whatsapp_phone',
  identityValue: phone,
  alternateIdentities: [],
  profileName: 'Priya Deshmukh',
  receivedAt: new Date(),
  parts: [{ type: 'TEXT', text }],
});

beforeAll(async () => {
  t = await createTestDatabase();
  await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, 'lead@x.test', 'Anjali Rao', 'CS_LEAD')`, [lead.userId]);
  teamId = uuidv7();
  queueId = uuidv7();
  await t.db.insert(teams).values({ id: teamId, name: 'Cards' });
  await t.db.insert(queues).values({ id: queueId, name: 'Cards & EMI · Tier 2' });
  await t.db.insert(queueTeams).values({ queueId, teamId });
  const agent = await new AgentService(t.db).create(ctx(lead), { name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', description: '', defaultQueueId: queueId });
  await t.db.update(virtualAgents).set({ status: 'LIVE' }).where(eq(virtualAgents.id, agent.id));
  channelId = uuidv7();
  await t.db.insert(channels).values({ id: channelId, kind: 'WHATSAPP', name: 'WhatsApp', status: 'ACTIVE', publicKey: 'pk1', defaultAgentId: agent.id });
});
afterAll(async () => {
  await t?.drop();
});

describe('ingress', () => {
  it('persists once and queues one turn for duplicate webhook deliveries', async () => {
    const ingress = new IngressService(t.db, queue);
    const [a, b] = await Promise.all([
      ingress.receive(channelId, msg('wamid.1', 'EMI debited twice'), 'c1'),
      ingress.receive(channelId, msg('wamid.1', 'EMI debited twice'), 'c2'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['accepted', 'duplicate']);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = 'wamid.1'`);
    expect(rows[0].n).toBe(1);
    expect(queue.pending('conversation.turn')).toBe(1);
  });

  it('appends to the open conversation with gap-free seq', async () => {
    const ingress = new IngressService(t.db, queue);
    const r = await ingress.receive(channelId, msg('wamid.2', 'card ending 4417'), 'c3');
    expect(r).toMatchObject({ status: 'accepted', created: false, seq: 2 });
  });

  it('creates exactly one customer on concurrent first contact', async () => {
    const ingress = new IngressService(t.db, queue);
    await Promise.all(Array.from({ length: 5 }, (_, i) => ingress.receive(channelId, msg(`wamid.new.${i}`, 'hi', '+919900077315'), `c${i}`)));
    const { rows } = await t.pool.query(`SELECT count(DISTINCT customer_id)::int AS n FROM customer_identities WHERE value = '+919900077315'`);
    expect(rows[0].n).toBe(1);
    const conv = await t.pool.query(`SELECT count(*)::int AS n FROM conversations c JOIN customer_identities i ON i.customer_id = c.customer_id WHERE i.value = '+919900077315'`);
    expect(conv.rows[0].n).toBe(1);
  });

  it('rejects inbound on inactive channels', async () => {
    const id = uuidv7();
    await t.db.insert(channels).values({ id, kind: 'WHATSAPP', name: 'off', status: 'DISABLED', publicKey: 'pk2' });
    expect(await new IngressService(t.db, queue).receive(id, msg('x', 'hi'), 'c')).toEqual({ status: 'rejected', reason: 'channel_inactive' });
  });
});

describe('control, visibility, timeline', () => {
  it('scopes the inbox by role and team', async () => {
    const inbox = new InboxService(t.db);
    const policy = { execsCanViewAiActive: true };
    const all = await inbox.list(lead, policy, { view: 'all', limit: 50 });
    expect(all.items.length).toBe(2);
    expect(all.items[0]!.customer.identity).toMatch(/•••/);
    const execInTeam: Principal = { userId: uuidv7(), role: 'CS_EXEC', displayName: 'E', teamIds: [teamId], via: 'UI' };
    const execElsewhere: Principal = { ...execInTeam, userId: uuidv7(), teamIds: [uuidv7()] };
    expect((await inbox.list(execInTeam, policy, { view: 'all', limit: 50 })).items.length).toBe(2);
    expect((await inbox.list(execElsewhere, policy, { view: 'all', limit: 50 })).items.length).toBe(0);
    expect((await inbox.list(execInTeam, { execsCanViewAiActive: false }, { view: 'all', limit: 50 })).items.length).toBe(0);
    const admin: Principal = { ...execInTeam, role: 'PLATFORM_TECH_ADMIN' };
    expect((await inbox.list(admin, policy, { view: 'all', limit: 50 })).items.length).toBe(0);
    expect(all.counts.ai).toBe(2);
  });

  it('applies control transitions with timeline, audit and events', async () => {
    const [conv] = await t.db.select().from(conversations).limit(1);
    await t.db.transaction((tx) =>
      applyControl(tx, conv!.id, {
        command: 'TAKE_OVER',
        actor: ctx(lead),
        transitionActor: 'HUMAN',
        description: 'taken over by Anjali Rao',
        patch: { assignedUserId: lead.userId },
        now: new Date(),
      }),
    );
    await expect(
      t.db.transaction((tx) =>
        applyControl(tx, conv!.id, { command: 'CLAIM', actor: ctx(lead), transitionActor: 'HUMAN', description: 'x', now: new Date() }),
      ),
    ).rejects.toMatchObject({ code: 'invalid_control_transition' });
    await addNote(t.db, ctx(lead), conv!.id, { body: 'Duplicate confirmed against batch file', passToAgent: true });
    const timeline = await loadTimeline(t.db, conv!.id);
    expect(timeline.map((i) => i.kind)).toEqual(['message', 'message', 'system', 'note']);
    const system = timeline.find((i) => i.kind === 'system');
    expect(system && 'text' in system ? system.text : '').toContain('HUMAN_ACTIVE');
    const detail = await loadConversationDetail(t.db, conv!.id);
    expect(detail).toMatchObject({ controlState: 'HUMAN_ACTIVE', assignedUser: { name: 'Anjali Rao' }, agent: { name: 'Maya' } });
    const audit = await t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1`, [conv!.id]);
    expect(audit.rows.map((r) => r.action)).toContain('conversation.take_over');
    const events = await t.db.execute(sql`SELECT type FROM outbox_events WHERE conversation_id = ${conv!.id} ORDER BY occurred_at`);
    expect(events.rows.map((r) => (r as { type: string }).type)).toContain('conversation.control_changed');
  });

  it('reopens a recently resolved conversation when the customer writes again', async () => {
    const [cust] = await t.db.select().from(customers).where(eq(customers.displayName, 'Priya Deshmukh'));
    const [conv] = await t.db.select().from(conversations).where(eq(conversations.customerId, cust!.id));
    await t.db.transaction((tx) =>
      applyControl(tx, conv!.id, { command: 'RESOLVE', actor: ctx(lead), transitionActor: 'HUMAN', description: 'resolved', patch: { resolvedAt: new Date() }, now: new Date() }),
    );
    const r = await new IngressService(t.db, queue).receive(channelId, msg('wamid.3', 'one more thing'), 'c9');
    expect(r).toMatchObject({ status: 'accepted', conversationId: conv!.id, created: false, turnQueued: true });
    const [after] = await t.db.select().from(conversations).where(eq(conversations.id, conv!.id));
    expect(after).toMatchObject({ controlState: 'AI_ACTIVE', reopenCount: 1 });
  });

  it('applies delivery statuses monotonically', async () => {
    const [conv] = await t.db.select().from(conversations).limit(1);
    const ext = 'wamid.out.1';
    await t.pool.query(`UPDATE interactions SET external_message_id = $1, delivery_status = 'SENT' WHERE conversation_id = $2 AND seq = 1`, [ext, conv!.id]);
    const ingress = new IngressService(t.db, queue);
    expect(await ingress.receiveStatuses(channelId, [{ externalMessageId: ext, status: 'READ' }], 'c')).toBe(1);
    expect(await ingress.receiveStatuses(channelId, [{ externalMessageId: ext, status: 'DELIVERED' }], 'c')).toBe(0);
    const { rows } = await t.pool.query(`SELECT delivery_status FROM interactions WHERE external_message_id = $1`, [ext]);
    expect(rows[0].delivery_status).toBe('READ');
  });
});
