import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { ChannelRegistry } from '@ocso/channels';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { LocalBlobStore } from '@ocso/blob';
import { MemoryQueue } from '@ocso/queue';
import { SettingsService, recordInstalledApproval } from '@ocso/application';
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
  createToolProviderRegistry,
} from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import { liveChannel, type Checker } from './platform.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';
import { routeChannel } from './routing.js';

/** Widget calls come from OCSO's own origin (the iframe); calls without an Origin need native apps or a pass. */
const WIDGET_ORIGIN = 'http://localhost:3000';

let channelChecker: Checker;
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
  const leadId = (await mk('lead@ocso.test', 'HEAD')).body.id;
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  // The lead (a Head, holding approvals.check.channels) approves the admin's channels (PM/research/11 §4).
  channelChecker = { id: leadId, token: lead };
  ids.team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [ids.team!]); // the lead's team owns Maya (ADR-026)
  await mk('exec@ocso.test', 'SERVICE', { teamIds: [ids.team] });
  exec = await h.loginAs('exec@ocso.test', 'a password 12345');
  await h.http().put('/v1/me/availability').set(auth(exec)).send({ availability: 'AVAILABLE' }).expect(200);
  ids.queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards & EMI · Tier 2', teamIds: [ids.team] }).expect(201)).body.id;

  // Model provider/profile rows (the admin API for these is tested separately).
  ids.provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: ids.provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  ids.profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: ids.profile, name: 'support-primary', providerId: ids.provider, model: 'scripted', retries: 0 });
  // An existing profile (grandfathered like 0031): agents go live only on approved profiles.
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: ids.profile, title: 'support-primary' }, 'Test fixture: existing profile');

  const agent = await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: ids.profile, defaultQueueId: ids.queue, teamIds: [ids.team] }).expect(201);
  ids.agent = agent.body.id;
  // Going live is a maker–checker approval (PM/research/11 §4): the lead is the owning team's only Head, so bootstrap.
  await h.http().post(`/v1/agents/${ids.agent}/status`).set(auth(lead)).send({ status: 'LIVE', approval: { bootstrap: true, reason: 'Sole Head of the owning team' } }).expect(202);

  const channel = { body: await liveChannel<{ id: string; publicKey: string }>(h, admin, channelChecker, { kind: 'WEBCHAT', name: 'Web chat', secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } }) };
  ids.webchatKey = channel.body.publicKey;
  // channel → pass-through router → Maya's queue (PM/research/11 §5).
  await routeChannel(h, channel.body.id, ids.agent!, ids.queue);
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
    toolRunner: (catalog) => new ToolRunner(h.db.db, catalog, createToolProviderRegistry(h.db.db), createAjvValidator(), null),
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
    const session = await h.http().post(`/public/webchat/${ids.webchatKey}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200);
    visitor = session.body.token;
    const sent = await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'c-000001', text: 'My EMI was debited twice' }).expect(201);
    expect(sent.body.status).toBe('accepted');
    conversationId = sent.body.conversationId;
    const dup = await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'c-000001', text: 'My EMI was debited twice' }).expect(201);
    expect(dup.body.status).toBe('duplicate');

    adapter.script = [{ text: 'Thanks — let me check the two debits.' }];
    expect(await runTurn(conversationId)).toEqual({ kind: 'ack' });
    const history = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(history.body.messages.map((m: { from: string; parts: Array<{ text?: string }> }) => [m.from, m.parts[0]?.text])).toEqual([
      ['customer', 'My EMI was debited twice'],
      ['agent', 'Thanks — let me check the two debits.'],
    ]);
    expect(history.body.agentName).toBe('Maya');
  });

  it('rejects another visitor reading this conversation', async () => {
    const other = (await h.http().post(`/public/webchat/${ids.webchatKey}/session`).set('origin', WIDGET_ORIGIN).send({}).expect(200)).body.token;
    const res = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(other)).expect(200);
    expect(res.body.messages).toEqual([]);
    await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth('wcv1.forged.token')).expect((r) => expect([401, 403]).toContain(r.status));
  });

  it('shows the conversation to the exec, routes a handoff, and lets them claim and reply', async () => {
    const inbox = await h.http().get('/v1/conversations?view=ai').set(auth(exec)).expect(200);
    expect(inbox.body.items.map((i: { id: string }) => i.id)).toContain(conversationId);
    await h.http().get('/v1/conversations').set(auth(admin)).expect(403);

    adapter.script = [
      { toolCalls: [{ toolName: 'ocso_request_handoff', input: { reason: 'refund above authority', summary: 'dup debit\nledger checked\napprove reversal', priority: 'P1' } }] },
      { text: 'A colleague will confirm here shortly.' },
    ];
    await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'c-000002', text: 'please reverse one' }).expect(201);
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
    const customerView = await h.http().get(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(JSON.stringify(customerView.body)).not.toContain('Duplicate confirmed');
    expect(customerView.body.messages.at(-1)).toMatchObject({ from: 'human', parts: [{ text: 'Reversal done: RVSL-5521904.' }] });
  });

  it('sends only attachments uploaded to this conversation, with server-verified metadata', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const upload = await h.http().post(`/v1/conversations/${conversationId}/attachments`).set(auth(exec)).set('content-type', 'image/png').set('x-ocso-filename', 'receipt.png').send(png).expect(201);
    expect(upload.body).toMatchObject({ partType: 'IMAGE', media: { mimeType: 'image/png', status: 'STORED', filename: 'receipt.png' } });
    expect(upload.body.media.blobKey).toMatch(new RegExp(`^staff/${conversationId}/`));
    await h.http().post(`/v1/conversations/${conversationId}/attachments`).set(auth(exec)).set('content-type', 'image/png').send(Buffer.from('not an image')).expect(400);

    const send = (id: string, media: Record<string, unknown>) =>
      h.http().post(`/v1/conversations/${conversationId}/messages`).set(auth(exec)).send({ clientMessageId: id, parts: [{ type: 'IMAGE', media }] });
    // Keys outside this conversation's staff prefix (e.g. another customer's upload) are refused.
    const foreign = await send('human-att-01', { blobKey: 'webchat/other-channel/visitor/x.png', mimeType: 'image/png', status: 'STORED' }).expect(400);
    expect(foreign.body.error.code).toBe('attachment_not_allowed');
    await send('human-att-02', { blobKey: `staff/${conversationId}/missing.png`, mimeType: 'image/png', status: 'STORED' }).expect(400);
    // Client-claimed metadata is replaced with what was stored.
    await send('human-att-03', { ...upload.body.media, mimeType: 'application/pdf', sizeBytes: 999999 }).expect(201);
    const timeline = await h.http().get(`/v1/conversations/${conversationId}/timeline`).set(auth(exec)).expect(200);
    const sent = JSON.stringify(timeline.body);
    expect(sent).toContain('"mimeType":"image/png"');
    expect(sent).not.toContain('999999');
  });

  it('returns control to the AI, which resumes with the handover context', async () => {
    await h.http().post(`/v1/conversations/${conversationId}/return-to-ai`).set(auth(exec)).send({ handoverSummary: 'Reversal RVSL-5521904 completed.' }).expect(204);
    adapter.script = [{ text: 'Your reference is RVSL-5521904.' }];
    await h.http().post(`/public/webchat/${ids.webchatKey}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'c-000003', text: 'what was the reference?' }).expect(201);
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
    const channel = {
      body: await liveChannel<{ id: string; publicKey: string }>(h, admin, channelChecker, {
        kind: 'WHATSAPP',
        name: 'WhatsApp Business',
        settings: { phoneNumberId: '1098765432' },
        secrets: { accessToken: 'EAAG-test-token', appSecret, verifyToken: 'verify-me-please' },
      }),
    };
    key = channel.body.publicKey;
    await routeChannel(h, channel.body.id, ids.agent!, ids.queue);
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
    // Maya is live (approved), so activating a prompt is a proposal; the lead is the team's only Head (bootstrap).
    await h.http().post(`/v1/agents/${ids.agent}/prompt/versions/${version.body.id}/activate`).set(auth(lead)).expect(409);
    const activated = await h.http().post(`/v1/agents/${ids.agent}/prompt/versions/${version.body.id}/activate`).set(auth(lead)).send({ approval: { bootstrap: true } }).expect(202);
    expect(activated.body.proposal).toMatchObject({ status: 'APPROVED', bootstrap: true });
    const preview = await h.http().get(`/v1/agents/${ids.agent}/prompt/preview`).set(auth(lead)).expect(200);
    expect(preview.body.hashes.promptVersionHash).toBe(version.body.promptHash);
  });
});
