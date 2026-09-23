import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { RoutingEngine } from '@ocso/application';
import { modelProfiles, modelProviders, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { activeWebChat } from './routing-web.js';
import { setTeams } from './teams.js';

/** Widget calls come from OCSO's own origin (the iframe); calls without an Origin need native apps or a pass. */
const WIDGET_ORIGIN = 'http://localhost:3000';

/**
 * Routing maker–checker over HTTP (PM/research/11 §4, §5.7; wave 2): a Lead
 * builds a language menu (English / Tamil) over two attribute queues; nothing
 * routes until a Head approves the queues and the router; a web chat customer
 * who picks Tamil lands in the Tamil queue. Queue and SLA changes after
 * approval are proposals (202), stops apply at once.
 */
let h: ApiHarness;
let admin: string;
let lead: string;
let head: string;
const ids: Record<string, string> = {};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const menu = () => ({
  steps: [
    {
      id: 'lang',
      kind: 'ASK',
      attribute: 'language',
      prompt: { text: 'Choose a language / மொழியைத் தேர்ந்தெடுக்கவும்' },
      options: [
        { value: 'en', label: 'English' },
        { value: 'ta', label: 'Tamil' },
      ],
      maxAttempts: 2,
      skipIfKnown: false,
    },
  ],
  rules: [{ when: { language: 'ta' }, queueId: ids.tamil }],
  fallbackQueueId: ids.english,
  returning: null,
  timeoutMinutes: 10,
});

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const mk = async (email: string, role: string) => (await h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345' }).expect(201)).body.id as string;
  const [leadId, headId] = [await mk('ra-lead@ocso.test', 'LEAD'), await mk('ra-head@ocso.test', 'HEAD')];
  head = await h.loginAs('ra-head@ocso.test', 'a password 12345');
  ids.team = (await h.http().post('/v1/teams').set(auth(head)).send({ name: 'Language desk' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [ids.team!]);
  await setTeams(h, admin, headId, [ids.team!]);
  ids.headId = headId;
  lead = await h.loginAs('ra-lead@ocso.test', 'a password 12345');
  const agent = async (name: string) => (await h.http().post('/v1/agents').set(auth(lead)).send({ name, purpose: name, conversationType: 'SUPPORT', teamIds: [ids.team] }).expect(201)).body.id as string;
  ids.maya = await agent('Maya');
  ids.arjun = await agent('Arjun');
  // Agents going live is the agent descriptor's approval (covered by approvals-flow); here they simply are.
  const [provider, profile] = [uuidv7(), uuidv7()];
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'ra-answers', providerId: provider, model: 'scripted' });
  await h.db.db.update(virtualAgents).set({ status: 'LIVE', modelProfileId: profile }).where(inArray(virtualAgents.id, [ids.maya, ids.arjun]));
});
afterAll(async () => {
  await h?.close();
});

describe('a Lead builds a language menu; a Head approves it', () => {
  it('drafts: queues with attributes and agents, a router attached to the channel — all direct, nothing routes', async () => {
    ids.tamil = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Tamil', teamIds: [ids.team], agentId: ids.maya, attributes: { language: 'ta' } }).expect(201)).body.id;
    ids.english = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'English', teamIds: [ids.team], agentId: ids.arjun, attributes: { language: 'en' } }).expect(201)).body.id;
    // A draft queue changes directly.
    await h.http().patch(`/v1/queues/${ids.english}`).set(auth(lead)).send({ acceptTimeoutSeconds: 90 }).expect(204);
    const channel = await activeWebChat(h, admin, { token: head, id: ids.headId! }, 'Language chat');
    ids.channel = channel.id;
    ids.key = channel.publicKey;
    ids.router = (await h.http().post('/v1/routers').set(auth(lead)).send({ name: 'Language menu', definition: menu() }).expect(201)).body.id;
    ids.version = (await h.http().post(`/v1/routers/${ids.router}/versions`).set(auth(lead)).send({ reason: 'first' }).expect(201)).body.id;
    const attached = await h.http().put(`/v1/routers/${ids.router}/channels`).set(auth(lead)).send({ channelIds: [ids.channel] }).expect(200);
    expect(attached.body).toEqual({ detached: [], attached: [ids.channel] });
    const visitor = (await h.http().post(`/public/webchat/${ids.key}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200)).body.token;
    await h.http().post(`/public/webchat/${ids.key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_ra_0000', text: 'hello?' }).expect(400);
  });

  it('activation is always a proposal, and only over approved queues', async () => {
    const plain = await h.http().post(`/v1/routers/${ids.router}/activate`).set(auth(lead)).send({ versionId: ids.version }).expect(409);
    expect(plain.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' } });
    const refused = await h.http().post(`/v1/routers/${ids.router}/activate`).set(auth(lead)).send({ versionId: ids.version, approval: { checkerId: ids.headId, reason: 'Language menu for web chat' } }).expect(400);
    expect(refused.body.error.code).toBe('validation_failed');
    for (const q of [ids.tamil, ids.english]) {
      const sent = await h.http().post(`/v1/queues/${q}/submit`).set(auth(lead)).send({ approval: { checkerId: ids.headId, reason: 'New language queue' } }).expect(202);
      expect(sent.body.proposal).toMatchObject({ objectKind: 'queue', action: 'CREATE', status: 'SUBMITTED' });
    }
    const proposed = await h.http().post(`/v1/routers/${ids.router}/activate`).set(auth(lead)).send({ versionId: ids.version, approval: { checkerId: ids.headId, reason: 'Language menu for web chat' } }).expect(202);
    expect(proposed.body.proposal).toMatchObject({ title: 'Activate router Language menu v1', warnings: expect.arrayContaining([expect.objectContaining({ code: 'validation_failed' })]) });
    ids.routerProposal = proposed.body.proposal.id;
    const state = (await h.http().get(`/v1/routers/${ids.router}`).set(auth(lead)).expect(200)).body;
    expect(state).toMatchObject({ status: 'DRAFT', latestVersionId: ids.version, approval: { pending: { id: ids.routerProposal } } });
  });

  it('the Head approves the queues (bulk), then the router; a customer who picks Tamil lands in the Tamil queue', async () => {
    const awaiting = (await h.http().get('/v1/approvals?box=AWAITING_ME').set(auth(head)).expect(200)).body.rows as Array<{ id: string; objectKind: string; contentHash: string }>;
    const queues = awaiting.filter((r) => r.objectKind === 'queue');
    expect(queues).toHaveLength(2);
    const bulk = await h.http().post('/v1/approvals/bulk-decision').set(auth(head)).send({ decision: 'APPROVE', reason: 'Queues reviewed', items: queues.map((q) => ({ id: q.id, contentHash: q.contentHash })) }).expect(200);
    expect(bulk.body.approved).toHaveLength(2);
    const shown = (await h.http().get(`/v1/approvals/${ids.routerProposal}`).set(auth(head)).expect(200)).body;
    expect(shown.after).toMatchObject({ status: 'ACTIVE', rules: ['1. language=ta → Tamil'], fallbackQueue: 'English', channels: ['Language chat'] });
    const decided = await h.http().post(`/v1/approvals/${ids.routerProposal}/decision`).set(auth(head)).send({ decision: 'APPROVE', reason: 'Reviewed the menu', contentHash: shown.contentHash }).expect(200);
    expect(decided.body.status).toBe('APPROVED');

    const visitor = (await h.http().post(`/public/webchat/${ids.key}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200)).body.token;
    const sent = await h.http().post(`/public/webchat/${ids.key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_ra_0001', text: 'vanakkam' }).expect(201);
    const engine = new RoutingEngine({ db: h.db.db, queue: new MemoryQueue() });
    await engine.advance(sent.body.conversationId, 'r1');
    await h.http().post(`/public/webchat/${ids.key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_ra_0002', text: 'Tamil' }).expect(201);
    await engine.advance(sent.body.conversationId, 'r2');
    const detail = (await h.http().get(`/v1/conversations/${sent.body.conversationId}`).set(auth(lead)).expect(200)).body;
    expect(detail).toMatchObject({ controlState: 'AI_ACTIVE', agent: { id: ids.maya }, queue: { id: ids.tamil }, routing: { outcome: 'RULE', attributes: { language: 'ta' }, rule: 'language=ta' } });
  });
});

describe('after approval', () => {
  it('a queue change is a proposal; removing a transfer target is a stop', async () => {
    const needs = await h.http().patch(`/v1/queues/${ids.tamil}`).set(auth(lead)).send({ acceptTimeoutSeconds: 60 }).expect(409);
    expect(needs.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'queue', objectId: ids.tamil, action: 'UPDATE' } });
    const proposed = await h.http().patch(`/v1/queues/${ids.tamil}`).set(auth(lead)).send({ acceptTimeoutSeconds: 60, transferTargetIds: [ids.english], approval: { checkerId: ids.headId, reason: 'Tamil may hand over to English' } }).expect(202);
    expect(proposed.body.proposal.changedFields).toEqual(expect.arrayContaining(['acceptTimeoutSeconds', 'transferTargets']));
    // Locked for approvable writes while open…
    await h.http().patch(`/v1/queues/${ids.tamil}`).set(auth(lead)).send({ languages: ['ta'] }).expect(409);
    const shown = (await h.http().get(`/v1/approvals/${proposed.body.proposal.id}`).set(auth(head)).expect(200)).body;
    await h.http().post(`/v1/approvals/${shown.id}/decision`).set(auth(head)).send({ decision: 'APPROVE', reason: 'ok', contentHash: shown.contentHash }).expect(200);
    const listed = (await h.http().get('/v1/queues').set(auth(lead)).expect(200)).body.find((q: { id: string }) => q.id === ids.tamil);
    expect(listed).toMatchObject({ acceptTimeoutSeconds: 60, transferTargetIds: [ids.english] });
    // …never for stops.
    await h.http().patch(`/v1/queues/${ids.tamil}`).set(auth(lead)).send({ transferTargetIds: [] }).expect(204);
  });

  it('SLA policies: created as drafts, submitted in one call, changed through proposals', async () => {
    const created = await h.http().post('/v1/sla-policies').set(auth(lead)).send({ name: 'Language SLA', firstHumanResponseSeconds: 600, approval: { checkerId: ids.headId, reason: 'SLA for the language desk' } }).expect(202);
    expect(created.body).toMatchObject({ id: expect.any(String), proposal: { objectKind: 'sla_policy', action: 'CREATE' } });
    await h.http().put(`/v1/sla-policies/${created.body.id}`).set(auth(lead)).send({ name: 'Language SLA', firstHumanResponseSeconds: 300 }).expect(409);
  });

  it('disabling is immediate; detaching a channel is immediate; renaming is a proposal', async () => {
    await h.http().patch(`/v1/routers/${ids.router}`).set(auth(lead)).send({ name: 'Languages' }).expect(409);
    await h.http().post(`/v1/routers/${ids.router}/disable`).set(auth(lead)).expect(204);
    // Swapping channels: the one left out is detached at once (a stop); the new one needs approval — and the
    // refusal says the detach already happened.
    const second = await activeWebChat(h, admin, { token: head, id: ids.headId! }, 'Second chat');
    const swapped = await h.http().put(`/v1/routers/${ids.router}/channels`).set(auth(lead)).send({ channelIds: [second.id] }).expect(409);
    expect(swapped.body.error).toMatchObject({ code: 'approval_required', details: { detached: [ids.channel] } });
    const detached = await h.http().put(`/v1/routers/${ids.router}/channels`).set(auth(lead)).send({ channelIds: [] }).expect(200);
    expect(detached.body.detached).toEqual([]);
    // It routed a customer: its versions are that customer's routing record, so it is disabled, never deleted.
    const refused = await h.http().delete(`/v1/routers/${ids.router}`).set(auth(lead)).send({ approval: { checkerId: ids.headId, reason: 'Clean up' } });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.body.error.details.problems).toEqual([expect.objectContaining({ code: 'router_has_history' })]);
    const resume = await h.http().post(`/v1/routers/${ids.router}/activate`).set(auth(lead)).send({ versionId: ids.version, approval: { checkerId: ids.headId, reason: 'Back on' } }).expect(202);
    expect(resume.body.proposal.title).toBe('Resume router Language menu (v1)');
  });

  it('a stale queue form keeps the transfer targets it never saw', async () => {
    const desk = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Desk', teamIds: [ids.team] }).expect(201)).body.id as string;
    // Opened with no targets; meanwhile English is added.
    await h.http().patch(`/v1/queues/${desk}`).set(auth(lead)).send({ transferTargetIds: [ids.english] }).expect(204);
    await h.http().patch(`/v1/queues/${desk}`).set(auth(lead)).send({ description: 'front desk', transferTargetIds: [], teamIds: [ids.team], baseline: { transferTargetIds: [], teamIds: [ids.team] } }).expect(204);
    const listed = (await h.http().get('/v1/queues').set(auth(lead)).expect(200)).body.find((q: { id: string }) => q.id === desk);
    expect(listed).toMatchObject({ description: 'front desk', transferTargetIds: [ids.english] });
  });
});
