import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { ChannelRegistry } from '@ocso/channels';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { LocalBlobStore } from '@ocso/blob';
import { MemoryQueue } from '@ocso/queue';
import { SettingsService } from '@ocso/application';
import { createAjvValidator } from '@ocso/tools';
import { createLogger } from '@ocso/observability';
import {
  ChannelRuntime,
  ContextBuilder,
  HotContextCache,
  LeaseManager,
  MediaMaterializer,
  ModelGateway,
  ToolRunner,
  TurnProcessor,
  UsageRecorder,
} from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

let h: ApiHarness;
let admin: string;
let lead: string;
let exec: string;
let processor: TurnProcessor;
let adapter: ScriptedAdapter;
const ids: Record<string, string> = {};
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const mk = async (email: string, role: string, extra: Record<string, unknown> = {}) =>
    h.http().post('/v1/users').set(auth(admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345', ...extra }).expect(201);
  await mk('lead@ocso.test', 'CS_LEAD');
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  ids.team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  await mk('exec@ocso.test', 'CS_EXEC', { teamIds: [ids.team] });
  exec = await h.loginAs('exec@ocso.test', 'a password 12345');
  await h.http().put('/v1/me/availability').set(auth(exec)).send({ availability: 'AVAILABLE' }).expect(200);
  ids.queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards & EMI · Tier 2', teamIds: [ids.team] }).expect(201)).body.id;

  // Model provider/profile rows (the admin API for these is tested separately).
  ids.provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: ids.provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  ids.profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: ids.profile, name: 'support-primary', providerId: ids.provider, model: 'scripted', retries: 0 });

  const agent = await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: ids.profile, defaultQueueId: ids.queue }).expect(201);
  ids.agent = agent.body.id;
  await h.http().post(`/v1/agents/${ids.agent}/status`).set(auth(lead)).send({ status: 'LIVE' }).expect(201);

  const channel = await h
    .http()
    .post('/v1/channels')
    .set(auth(admin))
    .send({ kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', defaultAgentId: ids.agent, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } })
    .expect(201);
  ids.webchatKey = channel.body.publicKey;
  expect(JSON.stringify(channel.body)).not.toMatch(/[0-9a-f]{64}/);

  adapter = new ScriptedAdapter(ids.provider);
  const settings = new SettingsService(h.db.db);
  processor = new TurnProcessor({
    db: h.db.db,
    queue: new MemoryQueue(),
    leases: new LeaseManager(h.db.db, 'test-worker', { leaseSeconds: 30, idleSeconds: 30 }),
    gateway: new ModelGateway(h.db.db, { get: async () => adapter }, new UsageRecorder(h.db.db), settings),
    context: new ContextBuilder(h.db.db, new HotContextCache(), { historyWindow: 20, mediaWindow: 6, timezone: 'UTC' }),
    media: new MediaMaterializer(h.db.db, new ChannelRuntime(h.db.db, new ChannelRegistry(), new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k', randomBytes(32).toString('base64')))), new LocalBlobStore({ rootDir: '/tmp/ocso-flow', publicApiBaseUrl: 'http://x', signingKey: 'k' })),
    toolRunner: (catalog) => new ToolRunner(h.db.db, catalog, { forConnection: async () => { throw new Error('no tools'); } }, createAjvValidator(), null),
    capabilitiesFor: async () => ({ imageInput: true, fileInput: true, audioInput: false }),
    logger: createLogger({ service: 'test', version: '0', level: 'fatal' }),
    summarizeAfter: 40,
  });
});

afterAll(async () => {
  await h?.close();
});

const runTurn = (conversationId: string) =>
  processor.handle({ id: uuidv7(), topic: 'conversation.turn', payload: { conversationId }, groupKey: conversationId, attempt: 1, enqueuedAt: new Date() });

describe('web chat → AI → human → AI over the API', () => {
  let visitor: string;
  let conversationId: string;

  it('lets a customer open a session and send a message that is persisted and answered', async () => {
    const session = await h.http().post(`/public/webchat/${ids.webchatKey}/session`).send({}).expect(200);
    visitor = session.body.token;
    const sent = await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).send({ clientMessageId: 'c-000001', text: 'My EMI was debited twice' }).expect(201);
    expect(sent.body.status).toBe('accepted');
    conversationId = sent.body.conversationId;
    const dup = await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).send({ clientMessageId: 'c-000001', text: 'My EMI was debited twice' }).expect(201);
    expect(dup.body.status).toBe('duplicate');

    adapter.script = [{ text: 'Thanks — let me check the two debits.' }];
    expect(await runTurn(conversationId)).toEqual({ kind: 'ack' });
    const history = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).expect(200);
    expect(history.body.messages.map((m: { from: string; parts: Array<{ text?: string }> }) => [m.from, m.parts[0]?.text])).toEqual([
      ['customer', 'My EMI was debited twice'],
      ['agent', 'Thanks — let me check the two debits.'],
    ]);
    expect(history.body.agentName).toBe('Maya');
  });

  it('rejects another visitor reading this conversation', async () => {
    const other = (await h.http().post(`/public/webchat/${ids.webchatKey}/session`).send({}).expect(200)).body.token;
    const res = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set(auth(other)).expect(200);
    expect(res.body.messages).toEqual([]);
    await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set(auth('wcv1.forged.token')).expect((r) => expect([401, 403]).toContain(r.status));
  });

  it('shows the conversation to the exec, routes a handoff, and lets them claim and reply', async () => {
    const inbox = await h.http().get('/v1/conversations?view=ai').set(auth(exec)).expect(200);
    expect(inbox.body.items.map((i: { id: string }) => i.id)).toContain(conversationId);
    await h.http().get('/v1/conversations').set(auth(admin)).expect(403);

    adapter.script = [
      { toolCalls: [{ toolName: 'ocso_request_handoff', input: { reason: 'refund above authority', summary: 'dup debit\nledger checked\napprove reversal', priority: 'P1' } }] },
      { text: 'A colleague will confirm here shortly.' },
    ];
    await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).send({ clientMessageId: 'c-000002', text: 'please reverse one' }).expect(201);
    await runTurn(conversationId);
    const waiting = await h.http().get('/v1/conversations?view=waiting').set(auth(exec)).expect(200);
    expect(waiting.body.items[0]).toMatchObject({ id: conversationId, controlState: 'WAITING_FOR_HUMAN', priority: 'P1' });

    await h.http().post(`/v1/conversations/${conversationId}/claim`).set(auth(exec)).expect(204);
    await h.http().post(`/v1/conversations/${conversationId}/claim`).set(auth(lead)).expect(409);
    await h.http().post(`/v1/conversations/${conversationId}/notes`).set(auth(exec)).send({ body: 'Duplicate confirmed', passToAgent: true }).expect(201);
    await h
      .http()
      .post(`/v1/conversations/${conversationId}/messages`)
      .set(auth(exec))
      .send({ clientMessageId: 'human-0001', parts: [{ type: 'TEXT', text: 'Reversal done: RVSL-5521904.' }] })
      .expect(201);
    const timeline = await h.http().get(`/v1/conversations/${conversationId}/timeline`).set(auth(exec)).expect(200);
    const kinds = timeline.body.map((i: { kind: string }) => i.kind);
    expect(kinds).toContain('note');
    expect(kinds).toContain('system');
    // Customers never see internal notes or system events.
    const customerView = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).expect(200);
    expect(JSON.stringify(customerView.body)).not.toContain('Duplicate confirmed');
    expect(customerView.body.messages.at(-1)).toMatchObject({ from: 'human', parts: [{ text: 'Reversal done: RVSL-5521904.' }] });
  });

  it('returns control to the AI, which resumes with the handover context', async () => {
    await h.http().post(`/v1/conversations/${conversationId}/return-to-ai`).set(auth(exec)).send({ handoverSummary: 'Reversal RVSL-5521904 completed.' }).expect(204);
    adapter.script = [{ text: 'Your reference is RVSL-5521904.' }];
    await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set(auth(visitor)).send({ clientMessageId: 'c-000003', text: 'what was the reference?' }).expect(201);
    await runTurn(conversationId);
    const detail = await h.http().get(`/v1/conversations/${conversationId}`).set(auth(lead)).expect(200);
    expect(detail.body.controlState).toBe('AI_ACTIVE');
    expect(JSON.stringify(adapter.requests.at(-1)!.system)).toContain('Duplicate confirmed');
  });
});

describe('WhatsApp webhook', () => {
  const appSecret = 'wa-app-secret-0123456789';
  let key: string;

  beforeAll(async () => {
    const channel = await h
      .http()
      .post('/v1/channels')
      .set(auth(admin))
      .send({
        kind: 'WHATSAPP',
        name: 'WhatsApp Business',
        status: 'ACTIVE',
        defaultAgentId: ids.agent,
        settings: { phoneNumberId: '1098765432' },
        secrets: { accessToken: 'EAAG-test-token', appSecret, verifyToken: 'verify-me-please' },
      })
      .expect(201);
    key = channel.body.publicKey;
  });

  it('answers the subscription challenge only with the right verify token', async () => {
    const ok = await h.http().get(`/channels/whatsapp/${key}/webhook?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=12345`).expect(200);
    expect(ok.text).toBe('12345');
    await h.http().get(`/channels/whatsapp/${key}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
  });

  it('verifies signatures, persists messages once and ignores duplicates', async () => {
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
        messaging_product: 'whatsapp',
        metadata: { display_phone_number: '15550000000', phone_number_id: '1098765432' },
        contacts: [{ profile: { name: 'Priya Deshmukh' }, wa_id: '919812341208' }],
        messages: [{ from: '919812341208', id: 'wamid.HBgM1', timestamp: '1758520000', type: 'text', text: { body: 'Hello from WhatsApp' } }],
      } }] }],
    });
    const sig = `sha256=${createHmac('sha256', appSecret).update(payload).digest('hex')}`;
    const post = () => h.http().post(`/channels/whatsapp/${key}/webhook`).set('content-type', 'application/json').set('x-hub-signature-256', sig).send(payload);
    expect((await post().expect(200)).body).toMatchObject({ accepted: 1, duplicates: 0 });
    expect((await post().expect(200)).body).toMatchObject({ accepted: 0, duplicates: 1 });
    await h.http().post(`/channels/whatsapp/${key}/webhook`).set('content-type', 'application/json').set('x-hub-signature-256', 'sha256=deadbeef').send(payload).expect((r) => expect([401, 403]).toContain(r.status));
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = 'wamid.HBgM1'`);
    expect(rows[0].n).toBe(1);
  });
});

describe('agent prompt workflow over the API', () => {
  it('drafts, versions, previews and activates a prompt; exec cannot edit', async () => {
    const prompt = await h.http().get(`/v1/agents/${ids.agent}/prompt`).set(auth(lead)).expect(200);
    const components = Object.fromEntries(prompt.body.components.filter((c: { key: string }) => c.key !== 'runtime_contract').map((c: { key: string; text: string }) => [c.key, c.text]));
    await h.http().put(`/v1/agents/${ids.agent}/prompt/draft`).set(auth(exec)).send({ ...components, behavior: 'x' }).expect(403);
    await h.http().put(`/v1/agents/${ids.agent}/prompt/draft`).set(auth(lead)).send({ ...components, behavior: 'Offer the reversal path first.' }).expect(204);
    const version = await h.http().post(`/v1/agents/${ids.agent}/prompt/versions`).set(auth(lead)).send({ reason: 'Duplicate-debit path shortened' }).expect(201);
    expect(version.body).toMatchObject({ version: 2, changedComponents: ['behavior'] });
    await h.http().post(`/v1/agents/${ids.agent}/prompt/versions/${version.body.id}/activate`).set(auth(lead)).expect(204);
    const preview = await h.http().get(`/v1/agents/${ids.agent}/prompt/preview`).set(auth(lead)).expect(200);
    expect(preview.body.hashes.promptVersionHash).toBe(version.body.promptHash);
  });
});
