import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditEvents, conversations, customers, modelProfiles, modelProviders, outboxEvents, uuidv7 } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';

/**
 * Conversation tags over the API: PUT …/tags (normalized replace set, audit,
 * live event), GET …/tags autocomplete scoped to visible conversations, the
 * inbox `tag` filter, tags added on resolve, and top tags in lead analytics.
 */
let h: ApiHarness;
let admin: string;
let lead: string;
let exec: string;
let outsider: string;
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const PASSWORD = 'a password 12345';

async function conversation(state: string, extra: Partial<typeof conversations.$inferInsert> = {}): Promise<string> {
  const customerId = uuidv7();
  await h.db.db.insert(customers).values({ id: customerId, displayName: `Customer ${customerId.slice(-4)}` });
  const id = uuidv7();
  await h.db.db.insert(conversations).values({ id, customerId, agentId: ids.agent!, type: 'SUPPORT', controlState: state, queueId: ids.queue!, ...extra });
  return id;
}

const tagsOf = async (id: string) => (await h.db.db.select({ tags: conversations.tags }).from(conversations).where(eq(conversations.id, id)))[0]?.tags;

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const mk = async (email: string, role: string, extra: Record<string, unknown> = {}) =>
    (await h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: PASSWORD, ...extra }).expect(201)).body.id as string;
  ids.lead = await mk('lead@ocso.test', 'CS_LEAD');
  lead = await h.loginAs('lead@ocso.test', PASSWORD);
  ids.team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  ids.otherTeam = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Loans' }).expect(201)).body.id;
  // The lead joins Cards, the team that owns Maya (ADR-026).
  await setTeams(h, admin, ids.lead!, [ids.team!]);
  ids.exec = await mk('exec@ocso.test', 'CS_EXEC', { teamIds: [ids.team] });
  exec = await h.loginAs('exec@ocso.test', PASSWORD);
  await mk('outsider@ocso.test', 'CS_EXEC', { teamIds: [ids.otherTeam] });
  outsider = await h.loginAs('outsider@ocso.test', PASSWORD);
  ids.queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards · Tier 2', teamIds: [ids.team] }).expect(201)).body.id;
  ids.provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: ids.provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  ids.profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: ids.profile, name: 'support', providerId: ids.provider, model: 'scripted', retries: 0 });
  ids.agent = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', modelProfileId: ids.profile, defaultQueueId: ids.queue, teamIds: [ids.team] }).expect(201)).body.id;

  ids.mine = await conversation('HUMAN_ACTIVE', { assignedUserId: ids.exec });
  ids.waiting = await conversation('WAITING_FOR_HUMAN', { waitingSince: new Date() });
  ids.hidden = await conversation('HUMAN_ACTIVE', { queueId: null, assignedUserId: ids.lead });
});

afterAll(async () => {
  await h?.close();
});

describe('PUT /v1/conversations/:id/tags', () => {
  it('normalizes (trim, lowercase, collapse spaces), de-duplicates and returns the stored set', async () => {
    const res = await h
      .http()
      .put(`/v1/conversations/${ids.mine}/tags`)
      .set(auth(exec))
      .send({ tags: ['  Refund ', 'EMI', 'refund', 'Duplicate   Debit', 'card_fee-waiver'] })
      .expect(200);
    expect(res.body).toEqual({ tags: ['refund', 'emi', 'duplicate debit', 'card_fee-waiver'] });
    expect(await tagsOf(ids.mine!)).toEqual(['refund', 'emi', 'duplicate debit', 'card_fee-waiver']);
    const detail = await h.http().get(`/v1/conversations/${ids.mine}`).set(auth(exec)).expect(200);
    expect(detail.body.tags).toEqual(['refund', 'emi', 'duplicate debit', 'card_fee-waiver']);
  });

  it('rejects invalid tags and more than 20 distinct tags', async () => {
    for (const bad of ['-refund', '', '   ', 'a'.repeat(41), 'refund!', 'naïve']) {
      await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(exec)).send({ tags: [bad] }).expect(400);
    }
    const many = Array.from({ length: 21 }, (_, i) => `tag ${i}`);
    await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(exec)).send({ tags: many }).expect(400);
    // 21 raw entries that collapse to 20 distinct tags are fine.
    const twenty = await h.http().put(`/v1/conversations/${ids.waiting}/tags`).set(auth(lead)).send({ tags: [...many.slice(0, 20), 'TAG 0'] }).expect(200);
    expect(twenty.body.tags).toHaveLength(20);
    await h.http().put(`/v1/conversations/${ids.waiting}/tags`).set(auth(lead)).send({ tags: ['refund'] }).expect(200);
    expect(await tagsOf(ids.mine!)).toEqual(['refund', 'emi', 'duplicate debit', 'card_fee-waiver']);
  });

  it('writes an audit row with before/after and a conversation.updated event', async () => {
    await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(exec)).send({ tags: ['refund', 'emi', 'merchant terminal'] }).expect(200);
    const audits = await h.db.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, 'conversation.tags_changed'), eq(auditEvents.targetId, ids.mine!)));
    const last = audits.at(-1)!;
    expect(last).toMatchObject({
      actorId: ids.exec,
      targetType: 'conversation',
      before: { tags: ['refund', 'emi', 'duplicate debit', 'card_fee-waiver'] },
      after: { tags: ['refund', 'emi', 'merchant terminal'] },
    });
    expect(last.summary).toContain('+merchant terminal');
    expect(last.summary).toContain('−duplicate debit');
    const events = await h.db.db.select().from(outboxEvents).where(and(eq(outboxEvents.type, 'conversation.updated'), eq(outboxEvents.conversationId, ids.mine!)));
    expect(events.at(-1)?.payload).toEqual({ fields: ['tags'] });

    // Same set again (any order): no new audit row.
    await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(exec)).send({ tags: ['EMI', 'merchant terminal', 'refund'] }).expect(200);
    const again = await h.db.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'conversation.tags_changed'), eq(auditEvents.targetId, ids.mine!)));
    expect(again).toHaveLength(audits.length);
  });

  it('denies an exec without access to the conversation, and the Tech Admin', async () => {
    await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(outsider)).send({ tags: ['spam'] }).expect(403);
    await h.http().put(`/v1/conversations/${ids.hidden}/tags`).set(auth(exec)).send({ tags: ['spam'] }).expect(403);
    await h.http().put(`/v1/conversations/${ids.mine}/tags`).set(auth(admin)).send({ tags: ['spam'] }).expect(403);
    expect(await tagsOf(ids.mine!)).toEqual(['refund', 'emi', 'merchant terminal']);
    expect(await tagsOf(ids.hidden!)).toEqual([]);
  });
});

describe('tag autocomplete and inbox filter', () => {
  it('suggests the most used tags among conversations the caller can see', async () => {
    await h.http().put(`/v1/conversations/${ids.hidden}/tags`).set(auth(lead)).send({ tags: ['vip', 'refund'] }).expect(200);
    const forLead = await h.http().get('/v1/conversations/tags').set(auth(lead)).expect(200);
    expect(forLead.body.items[0]).toEqual({ tag: 'refund', count: 3 });
    expect(forLead.body.items.map((i: { tag: string }) => i.tag)).toContain('vip');
    const forExec = await h.http().get('/v1/conversations/tags').set(auth(exec)).expect(200);
    expect(forExec.body.items[0]).toEqual({ tag: 'refund', count: 2 });
    expect(forExec.body.items.map((i: { tag: string }) => i.tag)).not.toContain('vip');
    const prefixed = await h.http().get('/v1/conversations/tags?prefix=%20ME').set(auth(exec)).expect(200);
    expect(prefixed.body.items).toEqual([{ tag: 'merchant terminal', count: 1 }]);
    await h.http().get('/v1/conversations/tags').set(auth(admin)).expect(403);
  });

  it('filters the inbox by tag (normalized) and scopes the view counts to it', async () => {
    const res = await h.http().get('/v1/conversations?view=all&tag=Refund').set(auth(exec)).expect(200);
    expect(res.body.items.map((i: { id: string }) => i.id).sort()).toEqual([ids.mine, ids.waiting].sort());
    const emi = await h.http().get('/v1/conversations?view=all&tag=emi').set(auth(exec)).expect(200);
    expect(emi.body.items.map((i: { id: string; tags: string[] }) => [i.id, i.tags])).toEqual([[ids.mine, ['refund', 'emi', 'merchant terminal']]]);
    expect(emi.body.counts).toMatchObject({ all: 1, human: 1, waiting: 0 });
    const vip = await h.http().get('/v1/conversations?view=all&tag=vip').set(auth(exec)).expect(200);
    expect(vip.body.items).toEqual([]);
    await h.http().get('/v1/conversations?tag=bad!').set(auth(exec)).expect(400);
  });
});

describe('resolve with tags', () => {
  it('adds the tags to the existing set in the resolve transaction', async () => {
    await h.http().post(`/v1/conversations/${ids.mine}/resolve`).set(auth(exec)).send({ disposition: 'reversed', tags: ['Chargeback', 'refund'] }).expect(204);
    const detail = await h.http().get(`/v1/conversations/${ids.mine}`).set(auth(exec)).expect(200);
    expect(detail.body).toMatchObject({ controlState: 'RESOLVED', disposition: 'reversed', tags: ['refund', 'emi', 'merchant terminal', 'chargeback'] });
    const audit = await h.db.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'conversation.tags_changed'), eq(auditEvents.targetId, ids.mine!)));
    expect(audit.at(-1)?.summary).toContain('+chargeback');
    const resolved = await h.http().get('/v1/conversations?view=resolved&tag=chargeback').set(auth(exec)).expect(200);
    expect(resolved.body.items.map((i: { id: string }) => i.id)).toEqual([ids.mine]);
  });

  it('rejects invalid tags on resolve without resolving', async () => {
    await h.http().post(`/v1/conversations/${ids.waiting}/claim`).set(auth(exec)).expect(204);
    await h.http().post(`/v1/conversations/${ids.waiting}/resolve`).set(auth(exec)).send({ tags: ['!!'] }).expect(400);
    const detail = await h.http().get(`/v1/conversations/${ids.waiting}`).set(auth(exec)).expect(200);
    expect(detail.body.controlState).toBe('HUMAN_ACTIVE');
    await h.http().post(`/v1/conversations/${ids.waiting}/resolve`).set(auth(exec)).send({}).expect(204);
    expect(await tagsOf(ids.waiting!)).toEqual(['refund']);
  });
});

describe('lead analytics', () => {
  it('reports the top tags of the cohort with a definition', async () => {
    const res = await h.http().get('/v1/analytics/overview?days=7').set(auth(lead)).expect(200);
    expect(res.body.tags.tagged).toBe(3);
    expect(res.body.tags.items[0]).toEqual({ tag: 'refund', count: 3 });
    expect(res.body.tags.definition).toMatch(/tag/);
  });
});
