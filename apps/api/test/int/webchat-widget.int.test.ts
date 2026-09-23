import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { ChannelRegistry } from '@ocso/channels';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { LocalBlobStore } from '@ocso/blob';
import { MemoryQueue } from '@ocso/queue';
import { SettingsService, recordInstalledApproval } from '@ocso/application';
import { createAjvValidator } from '@ocso/tools';
import { createLogger } from '@ocso/observability';
import { ChannelRuntime, ContextBuilder, HotContextCache, LeaseManager, MediaMaterializer, ModelGateway, ToolRunner, TurnProcessor, UsageRecorder, createToolProviderRegistry } from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import { liveChannel } from './platform.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';
import { routeChannel } from './routing.js';

/** Widget calls come from OCSO's own origin (the iframe); calls without an Origin need native apps or a pass. */
const WIDGET_ORIGIN = 'http://localhost:3000';

/** Widget-facing additions to the public web chat API (config, origin allowlist, history notices). */

let h: ApiHarness;
let lead: string;
let exec: string;
let key: string;
let processor: TurnProcessor;
const adapter = { current: null as ScriptedAdapter | null };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const HOST = 'https://shop.example.test';
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

beforeAll(async () => {
  h = await startApi();
  const admin = await completeSetup(h);
  const mk = (email: string, name: string, role: string) => h.http().post('/v1/users').set(auth(admin)).send({ email, name, role, password: 'a password 12345' }).expect(201);
  const leadId = (await mk('lead@ocso.test', 'Lena Lead', 'HEAD')).body.id;
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Web' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [team]); // the lead's team owns the agent (ADR-026)
  await h.http().post('/v1/users').set(auth(admin)).send({ email: 'exec@ocso.test', name: 'Priya Rao', role: 'SERVICE', password: 'a password 12345', teamIds: [team] }).expect(201);
  exec = await h.loginAs('exec@ocso.test', 'a password 12345');
  await h.http().put('/v1/me/availability').set(auth(exec)).send({ availability: 'AVAILABLE' }).expect(200);
  const queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Web tier 1', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'widget-primary', providerId: provider, model: 'scripted', retries: 0 });
  // An existing profile (grandfathered like 0031): agents go live only on approved profiles.
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: profile, title: 'widget-primary' }, 'Test fixture: existing profile');
  const agent = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queue, teamIds: [team] }).expect(201)).body.id;
  // Going live is a maker–checker approval (PM/research/11 §4): the lead is the owning team's only Head, so bootstrap.
  await h.http().post(`/v1/agents/${agent}/status`).set(auth(lead)).send({ status: 'LIVE', approval: { bootstrap: true, reason: 'Sole Head of the owning team' } }).expect(202);
  const settings = { allowedOrigins: [HOST], audioAttachments: true, branding: { title: 'Meridian help', accentColor: '#0f766e', greeting: 'Hi! Ask us anything.' } };
  // A channel is a draft until a Head (approvals.check.channels) approves its activation (PM/research/11 §4).
  const created = await liveChannel<{ id: string; publicKey: string }>(h, admin, { id: leadId, token: lead }, { kind: 'WEBCHAT', name: 'Site chat', settings, secrets: { visitorTokenSecret: randomBytes(32).toString('hex') } });
  key = created.publicKey;
  await routeChannel(h, created.id, agent, queue);

  adapter.current = new ScriptedAdapter(provider);
  processor = new TurnProcessor({
    db: h.db.db,
    queue: new MemoryQueue(),
    leases: new LeaseManager(h.db.db, 'widget-worker', { leaseSeconds: 30, idleSeconds: 30 }),
    gateway: new ModelGateway(h.db.db, { get: async () => adapter.current! }, new UsageRecorder(h.db.db), new SettingsService(h.db.db)),
    context: new ContextBuilder(h.db.db, new HotContextCache(), { historyWindow: 20, mediaWindow: 6, timezone: 'UTC' }),
    media: new MediaMaterializer(h.db.db, new ChannelRuntime(h.db.db, new ChannelRegistry(), new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k', randomBytes(32).toString('base64')))), new LocalBlobStore({ rootDir: '/tmp/ocso-widget', publicApiBaseUrl: 'http://x', signingKey: 'k' })),
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

describe('web chat widget API', () => {
  let visitor: string;
  let conversationId: string;

  it('serves branding, limits and the embedding allowlist without secrets', async () => {
    const res = await h.http().get(`/public/webchat/${key}/config`).set('origin', WIDGET_ORIGIN).expect(200);
    expect(res.body).toMatchObject({
      assistantName: 'Maya',
      branding: { title: 'Meridian help', accentColor: '#0f766e', greeting: 'Hi! Ask us anything.', theme: 'light', position: 'right' },
      allowedOrigins: [HOST],
      hostIdentity: false,
      maxAttachmentsPerMessage: 5,
    });
    expect(res.body.inboundParts).toContain('AUDIO');
    expect(res.text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('rejects browser calls from sites outside the allowlist', async () => {
    await h.http().post(`/public/webchat/${key}/session`).set('origin', 'https://evil.test').send({}).expect(403);
    await h.http().post(`/public/webchat/${key}/session`).set('origin', HOST).send({}).expect(200);
    visitor = (await h.http().post(`/public/webchat/${key}/session`).set('origin', 'http://localhost:3000').send({}).expect(200)).body.token;
  });

  it('echoes the client message id and joins agent messages to their turn', async () => {
    const empty = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(empty.body).toMatchObject({ conversationId: null, agentName: 'Maya', messages: [], notices: [], status: { mode: 'ai' } });

    const upload = await h.http().post(`/public/webchat/${key}/attachments`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).set('content-type', 'image/png').send(PNG).expect(201);
    const sent = await h
      .http()
      .post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN)
      .set(auth(visitor))
      .send({ clientMessageId: 'cm_widget_0001', text: 'Here is my receipt', attachments: [{ uploadId: upload.body.uploadId, mimeType: 'image/png', sizeBytes: upload.body.sizeBytes, filename: 'receipt.png' }] })
      .expect(201);
    conversationId = sent.body.conversationId;
    adapter.current!.script = [{ text: 'Thanks, I can see the receipt.' }];
    await runTurn(conversationId);

    const history = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    const [mine, reply] = history.body.messages;
    expect(mine).toMatchObject({ from: 'customer', clientMessageId: 'cm_widget_0001', turnId: null });
    expect(mine.parts[1]).toMatchObject({ type: 'IMAGE', url: expect.stringContaining('/blobs/') });
    expect(JSON.stringify(mine)).not.toContain('blobKey');
    expect(reply).toMatchObject({ from: 'agent', name: 'Maya', clientMessageId: null, turnId: expect.any(String) });
    const after = await h.http().get(`/public/webchat/${key}/messages?afterSeq=${mine.seq}`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(after.body.messages.map((m: { id: string }) => m.id)).toEqual([reply.id]);
  });

  it('turns control changes into customer-safe notices and status', async () => {
    adapter.current!.script = [{ toolCalls: [{ toolName: 'ocso_request_handoff', input: { reason: 'wants a human', summary: 'receipt', priority: 'P2' } }] }, { text: 'A colleague will join shortly.' }];
    await h.http().post(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).send({ clientMessageId: 'cm_widget_0002', text: 'talk to a human' }).expect(201);
    await runTurn(conversationId);
    const waiting = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(waiting.body.status).toEqual({ mode: 'waiting', humanName: null });
    expect(waiting.body.notices.map((n: { kind: string }) => n.kind)).toEqual(['waiting']);

    await h.http().post(`/v1/conversations/${conversationId}/claim`).set(auth(exec)).expect(204);
    const joined = await h.http().get(`/public/webchat/${key}/messages`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).expect(200);
    expect(joined.body.status).toEqual({ mode: 'human', humanName: 'Priya' });
    expect(joined.body.notices.at(-1)).toMatchObject({ kind: 'joined', name: 'Priya', id: expect.any(String), seq: expect.any(Number) });
    expect(JSON.stringify(joined.body)).not.toMatch(/HUMAN_ACTIVE|WAITING_FOR_HUMAN|wants a human|Rao|exec@/);
  });

  it('accepts audio only in allowed formats and enforces per-kind limits', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
    await h.http().post(`/public/webchat/${key}/attachments`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).set('content-type', 'audio/mpeg').send(mp3).expect(201);
    const txt = await h.http().post(`/public/webchat/${key}/attachments`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).set('content-type', 'application/octet-stream').set('x-ocso-content-type', 'text/plain').send(Buffer.from('order 1234')).expect(201);
    expect(txt.body.mimeType).toBe('text/plain');
    const bad = await h.http().post(`/public/webchat/${key}/attachments`).set('origin', WIDGET_ORIGIN).set(auth(visitor)).set('content-type', 'application/octet-stream').send(Buffer.from('MZ\x90\x00')).expect(400);
    expect(bad.body.error.code).toBe('attachment_rejected');
  });
});
