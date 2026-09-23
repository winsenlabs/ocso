import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { RouterService, RoutingEngine, systemActor } from '@ocso/application';
import { modelProfiles, modelProviders, uuidv7, virtualAgents } from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { activeWebChat } from './routing-web.js';
import { setTeams } from './teams.js';

/** Widget calls come from OCSO's own origin (the iframe); calls without an Origin need native apps or a pass. */
const WIDGET_ORIGIN = 'http://localhost:3000';

/**
 * Routers over HTTP (PM/research/11 §5.7) and a menu router end to end
 * through the public web chat API: routers.read / routers.manage, 409
 * approval_required for activation and channel attachment, the simulator,
 * queue routing fields, and the conversation's routing block.
 */
let h: ApiHarness;
let admin: string;
let lead: string;
let exec: string;
const ids: Record<string, string> = {};
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

const menu = () => ({
  steps: [
    {
      id: 'product',
      kind: 'ASK',
      attribute: 'product',
      prompt: { text: 'What can we help with?' },
      options: [
        { value: 'cards', label: 'Cards & EMI' },
        { value: 'sales', label: 'Loans' },
      ],
      maxAttempts: 2,
      skipIfKnown: false,
    },
  ],
  rules: [{ when: { product: 'sales' }, queueId: ids.sales }],
  fallbackQueueId: ids.cards,
  returning: null,
  timeoutMinutes: 10,
});

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const mk = (email: string, role: string, extra: object = {}) => h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345', ...extra }).expect(201);
  const leadId = (await mk('router-lead@ocso.test', 'HEAD')).body.id;
  ids.leadId = leadId;
  lead = await h.loginAs('router-lead@ocso.test', 'a password 12345');
  ids.team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Routing' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [ids.team!]);
  await mk('router-exec@ocso.test', 'SERVICE', { teamIds: [ids.team] });
  exec = await h.loginAs('router-exec@ocso.test', 'a password 12345');
  const agent = (name: string, type: string) => h.http().post('/v1/agents').set(auth(lead)).send({ name, purpose: name, conversationType: type, teamIds: [ids.team] }).expect(201);
  ids.maya = (await agent('Maya', 'SUPPORT')).body.id;
  ids.arjun = (await agent('Arjun', 'SALES')).body.id;
  // Live with a model (what going live requires): routing hands customers only to agents that answer.
  const [provider, profile] = [uuidv7(), uuidv7()];
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'router-answers', providerId: provider, model: 'scripted' });
  await h.db.db.update(virtualAgents).set({ status: 'LIVE', modelProfileId: profile });
  ids.cards = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards', teamIds: [ids.team] }).expect(201)).body.id;
  ids.sales = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Sales', teamIds: [ids.team] }).expect(201)).body.id;
});
afterAll(async () => {
  await h?.close();
});

describe('queues carry their agent, attributes, hours and transfer targets', () => {
  it('PATCH sets them; attributes are unique across queues', async () => {
    await h.http().patch(`/v1/queues/${ids.cards}`).set(auth(lead)).send({ agentId: ids.maya, attributes: { product: 'cards' }, transferTargetIds: [ids.sales], businessHours: { timezone: 'Asia/Kolkata', humanHours: { mon: ['09:00', '18:00'] } } }).expect(204);
    await h.http().patch(`/v1/queues/${ids.sales}`).set(auth(lead)).send({ agentId: ids.arjun, attributes: { product: 'sales' } }).expect(204);
    const dup = await h.http().patch(`/v1/queues/${ids.sales}`).set(auth(lead)).send({ attributes: { product: 'cards' } }).expect(409);
    expect(dup.body.error.code).toBe('queue_attributes_taken');
    const listed = (await h.http().get('/v1/queues').set(auth(lead)).expect(200)).body.find((q: { id: string }) => q.id === ids.cards);
    expect(listed).toMatchObject({ agentId: ids.maya, attributes: { product: 'cards' }, transferTargetIds: [ids.sales], businessHours: { timezone: 'Asia/Kolkata' } });
    await h.http().patch(`/v1/queues/${ids.cards}`).set(auth(lead)).send({ attributes: { Product: 'x' } }).expect(400);
  });
});

describe('router API', () => {
  it('reads need routers.read, writes routers.manage', async () => {
    await h.http().get('/v1/routers').set(auth(exec)).expect(403);
    await h.http().post('/v1/routers').set(auth(exec)).send({ name: 'x', definition: menu() }).expect(403);
    await h.http().get('/v1/routers').set(auth(admin)).expect(200);
    await h.http().post('/v1/routers').set(auth(admin)).send({ name: 'x', definition: menu() }).expect(403);
  });

  it('draft → version → activate is 409 approval_required without a checker; simulate is a dry run; disable is immediate', async () => {
    const created = await h.http().post('/v1/routers').set(auth(lead)).send({ name: 'Web menu', definition: menu() }).expect(201);
    expect(created.body).toMatchObject({ status: 'DRAFT', draft: { problems: [] } });
    ids.router = created.body.id;
    await h.http().put(`/v1/routers/${ids.router}/draft`).set(auth(lead)).send({ definition: { ...menu(), fallbackQueueId: 'not-a-uuid' } }).expect(400);
    await h.http().put(`/v1/routers/${ids.router}/draft`).set(auth(lead)).send({ definition: { ...menu(), timeoutMinutes: 5 } }).expect(200);
    const version = await h.http().post(`/v1/routers/${ids.router}/versions`).set(auth(lead)).send({ reason: 'first' }).expect(201);
    expect(version.body.version).toBe(1);
    ids.version = version.body.id;

    const activate = await h.http().post(`/v1/routers/${ids.router}/activate`).set(auth(lead)).send({ versionId: ids.version }).expect(409);
    expect(activate.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'router', objectId: ids.router, action: 'ACTIVATE' } });
    await h.http().put(`/v1/routers/${ids.router}/channels`).set(auth(lead)).send({ channelIds: [] }).expect(200);

    const simulated = await h.http().post(`/v1/routers/${ids.router}/simulate`).set(auth(lead)).send({ messages: ['hello', 'loans'] }).expect(200);
    expect(simulated.body.decision).toMatchObject({ queueName: 'Sales', agentName: 'Arjun', outcome: 'RULE' });

    const listed = (await h.http().get('/v1/routers').set(auth(lead)).expect(200)).body;
    expect(listed.find((r: { id: string }) => r.id === ids.router)).toMatchObject({ status: 'DRAFT', activeVersion: null });
  });

  it('a menu router answers web chat visitors: ROUTING with CHOICES, then the chosen queue’s agent', async () => {
    const channel = await activeWebChat(h, admin, { token: lead, id: ids.leadId! }, 'Menu chat');
    // Approval would do this (wave 2); the application functions are what the router descriptor calls.
    await h.db.db.transaction(async (tx) => {
      await RouterService.activateVersion(tx, systemActor('test', 't'), ids.version!);
      await RouterService.attachChannels(tx, systemActor('test', 't'), ids.router!, [channel.id]);
    });
    const channelView = (await h.http().get('/v1/channels').set(auth(admin)).expect(200)).body.find((c: { id: string }) => c.id === channel.id);
    expect(channelView).toMatchObject({ router: { id: ids.router, name: 'Web menu', status: 'ACTIVE' }, defaultAgentId: null });

    const key = channel.publicKey;
    const config = await h.http().get(`/public/webchat/${key}/config`).set('origin', WIDGET_ORIGIN).expect(200);
    expect(config.body.assistantName).toBeNull();
    const visitor = (await h.http().post(`/public/webchat/${key}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200)).body.token;
    const sent = await h.http().post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_menu_0001', text: 'hi there' }).expect(201);
    const conversationId = sent.body.conversationId;
    const engine = new RoutingEngine({ db: h.db.db, queue: new MemoryQueue() });
    await engine.advance(conversationId, 'r1');

    const inbox = (await h.http().get('/v1/conversations?view=ai').set(auth(lead)).expect(200)).body.items.find((c: { id: string }) => c.id === conversationId);
    expect(inbox).toMatchObject({ controlState: 'ROUTING', agent: null });
    const history = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    const question = history.body.messages.at(-1);
    expect(question).toMatchObject({ from: 'agent', name: null, parts: [{ type: 'STRUCTURED', schema: 'ocso.choices', data: { options: [{ label: 'Cards & EMI' }, { label: 'Loans' }] } }] });

    await h.http().post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_menu_0002', text: 'Loans' }).expect(201);
    await engine.advance(conversationId, 'r2');
    const detail = (await h.http().get(`/v1/conversations/${conversationId}`).set(auth(lead)).expect(200)).body;
    expect(detail).toMatchObject({ controlState: 'AI_ACTIVE', agent: { id: ids.arjun, name: 'Arjun' }, queue: { id: ids.sales }, routing: { router: { id: ids.router, name: 'Web menu' }, outcome: 'RULE', ruleIndex: 0, attributes: { product: 'sales' } } });
    const after = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(after.body.agentName).toBe('Arjun');

    // Stopping is never gated: disabled, the router's channel takes no new messages.
    await h.http().post(`/v1/routers/${ids.router}/disable`).set(auth(lead)).expect(204);
    const [row] = await h.db.db.select({ status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, ids.arjun!));
    expect(row?.status).toBe('LIVE');
    const visitor2 = (await h.http().post(`/public/webchat/${key}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200)).body.token;
    await h.http().post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor2)).send({ clientMessageId: 'cm_menu_0003', text: 'anyone?' }).expect(400);
    // …while the visitor already talking to Arjun keeps reaching him.
    const still = await h.http().post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_menu_0004', text: 'still there?' }).expect(201);
    expect(still.body.conversationId).toBe(conversationId);
  });

  it('refuses channel ids on agents: channels reach agents through routers', async () => {
    const res = await h.http().patch(`/v1/agents/${ids.maya}`).set(auth(lead)).send({ channelIds: [ids.cards] }).expect(400);
    expect(res.body.error.code).toBe('channels_route_through_routers');
  });
});
