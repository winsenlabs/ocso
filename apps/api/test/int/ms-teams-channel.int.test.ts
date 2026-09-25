import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelRuntime, DeliveryService } from '@ocso/agent-runtime';
import { appendInteraction, readZip } from '@ocso/application';
import { TEAMS_MANIFEST_VERSION } from '@ocso/channels';
import type { BlobStore } from '@ocso/blob';
import { eq } from 'drizzle-orm';
import { deploymentSettings, modelProfiles, modelProviders, turns, uuidv7 } from '@ocso/db';
import { BLOB_STORE } from '../../src/infrastructure/tokens.js';
import { StaffChatService } from '../../src/modules/internal-agent/staff-chat.service.js';
import { liveChannel } from './platform.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';
import { routeChannel } from './routing.js';

/**
 * Microsoft Teams over the real API: the MS_TEAMS descriptor (settings, write-only client secret, Teams app
 * manifest), creation and activation by approval, `/channels/ms-teams/<publicKey>/webhook` with Bot Connector
 * JWT verification against a fake Bot Framework OpenID metadata + JWKS, persist-once ingress keyed on the
 * activity id, the conversation reference stored as the reply context, and delivery of the agent's reply
 * through a fake Entra token endpoint and a fake Bot Connector.
 */

const APP_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const USER_AAD = '29f4a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b';
const BYSTANDER_AAD = '3a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const APP_PASSWORD = 'Qx~8Q~integration.teams.secret_0001';
const BOT_ID = `28:${APP_ID}`;
const PERSONAL = 'a:1Xk9-personal-conversation-int';
const CHANNEL_THREAD = '19:abc123def456@thread.tacv2;messageid=1790244500000';
const KID = 'int-bf-key';

let h: ApiHarness;
let admin: string;
let stub: Server;
let stubUrl: string;
let serviceUrl: string;
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;
const calls: Array<{ path: string; auth: string | undefined; body: string }> = [];
let channel: { id: string; publicKey: string; webhookPath: string };
let askChannel: { id: string; publicKey: string; webhookPath: string };
let lead: string;
let leadId: string;
let agentId: string;
let posts = 0;
let tokensIssued = 0;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function connectorJwt(options: { aud?: string; serviceUrl?: string; exp?: number } = {}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - 30;
  return new SignJWT({ serviceurl: options.serviceUrl ?? serviceUrl })
    .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
    .setIssuer('https://api.botframework.com')
    .setAudience(options.aud ?? APP_ID)
    .setIssuedAt(iat)
    .setNotBefore(iat)
    .setExpirationTime(options.exp ?? iat + 3600)
    .sign(privateKey);
}

const activity = (id: string, overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  id,
  timestamp: new Date().toISOString(),
  serviceUrl,
  channelId: 'msteams',
  from: { id: '29:1asha', name: 'Asha Rao', aadObjectId: USER_AAD },
  recipient: { id: BOT_ID, name: 'OCSO Assistant' },
  conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
  channelData: { tenant: { id: TENANT } },
  text: 'Where is my new card?',
  textFormat: 'plain',
  ...overrides,
});

/** POST an activity to the webhook (with a valid connector token unless one is given; null = none) and expect a status. */
const post = async (body: unknown, status: number, token?: string | null, to: { webhookPath: string } = channel) => {
  const bearer = token === undefined ? await connectorJwt() : token;
  const req = h.http().post(to.webhookPath).set('content-type', 'application/json');
  if (bearer !== null) req.set('authorization', `Bearer ${bearer}`);
  return req.send(JSON.stringify(body)).expect(status);
};

async function inbound(activityId: string): Promise<{ conversationId: string; replyContext: Record<string, string> | null; seq: number }> {
  const { rows } = await h.db.pool.query(`SELECT conversation_id, reply_context, seq FROM interactions WHERE channel_id = $1 AND idempotency_key LIKE $2`, [channel.id, `teams:%:${activityId}`]);
  expect(rows).toHaveLength(1);
  return { conversationId: rows[0].conversation_id, replyContext: rows[0].reply_context, seq: rows[0].seq };
}

/** The agent's reply (what a turn persists; `answersSeq` = the turn's input), then the worker's channel.deliver job. */
async function agentReplies(conversationId: string, parts: unknown[], answersSeq?: number): Promise<string> {
  let turnId: string | undefined;
  if (answersSeq !== undefined) {
    turnId = uuidv7();
    await h.db.db.insert(turns).values({ id: turnId, conversationId, agentId, workerId: 'teams-int', leaseVersion: 1, seqFrom: answersSeq, seqTo: answersSeq, status: 'COMPLETED', outcome: 'REPLIED' });
  }
  const { interactionId } = await h.db.db.transaction((tx) =>
    appendInteraction(
      tx,
      conversationId,
      { actorType: 'AGENT', actorId: agentId, direction: 'OUTBOUND', visibility: 'CUSTOMER', idempotencyKey: `reply-${uuidv7()}`, parts: parts as never },
      { channelId: channel.id, deliveryStatus: 'PENDING', now: new Date(), ...(turnId ? { turnId } : {}) },
    ),
  );
  const delivery = new DeliveryService(h.db.db, h.app.get(ChannelRuntime), h.app.get<BlobStore>(BLOB_STORE));
  expect(await delivery.deliver(interactionId, `teams-${interactionId}`)).toEqual({ kind: 'sent' });
  return interactionId;
}

const connectorPosts = () => calls.filter((c) => c.path.includes('/v3/conversations/'));

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), kid: KID, use: 'sig', endorsements: ['msteams'] };

  // A local stand-in for Microsoft: Bot Framework OpenID metadata + keys, the Entra token endpoint and the Bot Connector.
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const path = req.url ?? '';
      calls.push({ path, auth: req.headers.authorization, body: raw });
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      if (path === '/v1/.well-known/openidconfiguration') return reply(200, { issuer: 'https://api.botframework.com', jwks_uri: `${stubUrl}/v1/.well-known/keys` });
      if (path === '/v1/.well-known/keys') return reply(200, { keys: [publicJwk] });
      if (path === `/${TENANT}/oauth2/v2.0/token`) {
        const form = new URLSearchParams(raw);
        if (form.get('client_id') !== APP_ID || form.get('client_secret') !== APP_PASSWORD) return reply(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' });
        tokensIssued += 1;
        return reply(200, { token_type: 'Bearer', expires_in: 3599, access_token: `connector-token-${tokensIssued}` });
      }
      if (path.startsWith('/amer/v3/conversations/')) {
        if (!req.headers.authorization?.startsWith('Bearer connector-token-')) return reply(401, { error: { code: 'Unauthorized' } });
        posts += 1;
        return reply(201, { id: `1790245000${String(posts).padStart(3, '0')}` });
      }
      return reply(404, { error: { code: 'NotFound' } });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  serviceUrl = `${stubUrl}/amer/`;

  h = await startApi({ env: { OCSO_ENABLE_DEV_PROVIDERS: 'true' } });
  admin = await completeSetup(h);
  await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ egressAllowedInternalHosts: ['127.0.0.1'], approval: { bootstrap: true, reason: 'Sole Tech: local Bot Framework stub' } }).expect(202);
  leadId = (await h.http().post('/v1/users').set(auth(admin)).send({ email: 'lead@ocso.test', name: 'lead', role: 'HEAD', password: 'a password 12345' }).expect(201)).body.id as string;
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [team]);
  const queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'support-primary', providerId: provider, model: 'scripted', retries: 0 });
  agentId = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queue, teamIds: [team] }).expect(201)).body.id;

  const created = await liveChannel<{ id: string; publicKey: string; webhookPath: string }>(h, admin, { id: leadId, token: lead }, {
    kind: 'MS_TEAMS',
    name: 'Meridian Teams',
    settings: {
      appId: APP_ID,
      tenantId: TENANT,
      appType: 'SingleTenant',
      endpoints: { openIdMetadataUrl: `${stubUrl}/v1/.well-known/openidconfiguration`, tokenUrl: `${stubUrl}/${TENANT}/oauth2/v2.0/token`, serviceUrlHosts: ['127.0.0.1'] },
    },
    secrets: { appPassword: APP_PASSWORD },
  });
  expect(JSON.stringify(created)).not.toContain(APP_PASSWORD);
  channel = created;
  await routeChannel(h, channel.id, agentId, queue);

  // A second Teams bot whose messages go to Ask OCSO (staff chat), on the development scripted model.
  await h.db.db.update(deploymentSettings).set({ internalAgentProfileId: profile }).where(eq(deploymentSettings.id, 1));
  askChannel = await liveChannel<{ id: string; publicKey: string; webhookPath: string }>(h, admin, { id: leadId, token: lead }, {
    kind: 'MS_TEAMS',
    name: 'Ask OCSO Teams',
    settings: {
      destination: 'ask_ocso',
      appId: APP_ID,
      tenantId: TENANT,
      appType: 'SingleTenant',
      endpoints: { openIdMetadataUrl: `${stubUrl}/v1/.well-known/openidconfiguration`, tokenUrl: `${stubUrl}/${TENANT}/oauth2/v2.0/token`, serviceUrlHosts: ['127.0.0.1'] },
    },
    secrets: { appPassword: APP_PASSWORD },
  });
});

afterAll(async () => {
  await h?.close();
  await new Promise((resolve) => stub?.close(resolve));
});

/** superagent: collect a binary body as a Buffer. */
function binary(res: NodeJS.ReadableStream & { setEncoding(e: string): void }, done: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
  res.on('end', () => done(null, Buffer.concat(chunks)));
}

describe('Microsoft Teams channel kind', () => {
  it('is served to the admin form with its settings, write-only client secret and Teams app manifest', async () => {
    const kinds = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    const teams = kinds.body.find((k: { kind: string }) => k.kind === 'MS_TEAMS');
    expect(teams).toMatchObject({ label: 'Microsoft Teams', mark: { code: 'MT' }, inboundWebhook: true, webhookSegment: 'ms-teams', connectionCheck: true, messageTemplates: false });
    expect(teams.secrets.map((s: { key: string }) => s.key)).toEqual(['appPassword']);
    expect(teams.setupFiles[0]).toMatchObject({ key: 'teams-app-package', filename: 'ocso-teams-app.zip', contentType: 'application/zip' });
    expect(teams.setupFiles[0].entries[0].template).toContain('"botId": "{{settings.appId}}"');
    expect(teams.setupGuide.length).toBeGreaterThan(5);
    expect(teams.troubleshooting.map((t: { id: string }) => t.id)).toContain('unauthorized');
    expect(channel.webhookPath).toBe(`/channels/ms-teams/${channel.publicKey}/webhook`);
  });

  it('builds the Teams app package on the server from the saved App ID, for readers of channels only, never with the secret', async () => {
    const res = await h.http().get(`/v1/channels/${channel.id}/setup-files/teams-app-package`).set(auth(admin)).buffer(true).parse(binary as never).expect(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toBe('attachment; filename="ocso-teams-app.zip"');
    const files = readZip(res.body as Buffer);
    expect([...files.keys()].sort()).toEqual(['color.png', 'manifest.json', 'outline.png']);
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8')) as { id: string; manifestVersion: string; bots: Array<{ botId: string }>; validDomains: string[] };
    expect(manifest).toMatchObject({ id: APP_ID, manifestVersion: TEAMS_MANIFEST_VERSION, bots: [{ botId: APP_ID }] });
    // The OCSO host (the harness's default public URL) is the only valid domain.
    expect(manifest.validDomains).toEqual(['localhost:3000']);
    expect(files.get('color.png')!.readUInt32BE(16)).toBe(192);
    expect(files.get('outline.png')!.readUInt32BE(16)).toBe(32);
    expect((res.body as Buffer).toString('latin1')).not.toContain(APP_PASSWORD);
    // A Head reads channels (read-only), so may download it; frontline staff may not.
    await h.http().get(`/v1/channels/${channel.id}/setup-files/teams-app-package`).set(auth(lead)).expect(200);
    await h.http().post('/v1/users').set(auth(admin)).send({ email: 'pkg-exec@ocso.test', name: 'exec', role: 'SERVICE', password: 'a password 12345' }).expect(201);
    const exec = await h.loginAs('pkg-exec@ocso.test', 'a password 12345');
    await h.http().get(`/v1/channels/${channel.id}/setup-files/teams-app-package`).set(auth(exec)).expect(403);
    await h.http().get(`/v1/channels/${channel.id}/setup-files/teams-app-package`).expect(401);
    await h.http().get(`/v1/channels/${channel.id}/setup-files/no-such-file`).set(auth(admin)).expect(404);
  });

  it('saves a draft before the Azure values exist, so its webhook URL is known; the package waits for the App ID and activation for everything', async () => {
    const draft = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'MS_TEAMS', name: 'Teams draft', settings: {}, secrets: {} }).expect(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', webhookPath: `/channels/ms-teams/${draft.body.publicKey}/webhook` });
    const early = await h.http().get(`/v1/channels/${draft.body.id}/setup-files/teams-app-package`).set(auth(admin)).expect(400);
    expect(early.body.error).toMatchObject({ code: 'setup_file_incomplete', message: expect.stringContaining('appId') });
    // A value that is given is still checked on a draft.
    await h.http().patch(`/v1/channels/${draft.body.id}`).set(auth(admin)).send({ settings: { appId: 'not-a-guid' } }).expect(400);
    await h.http().patch(`/v1/channels/${draft.body.id}`).set(auth(admin)).send({ settings: { appId: APP_ID, appType: 'MultiTenant' } }).expect(200);
    await h.http().get(`/v1/channels/${draft.body.id}/setup-files/teams-app-package`).set(auth(admin)).expect(200);
    // Activation checks the whole configuration: the client secret is still missing.
    const activate = await h.http().patch(`/v1/channels/${draft.body.id}`).set(auth(admin)).send({ status: 'ACTIVE', approval: { checkerId: leadId, reason: 'try' } });
    expect(activate.status).toBe(400);
    expect(JSON.stringify(activate.body)).toContain('appPassword');
  });

  it('refuses an invalid configuration without echoing the secret', async () => {
    const res = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'MS_TEAMS', name: 'Broken', settings: { appId: 'not-a-guid' }, secrets: { appPassword: 'broken secret value' } }).expect(400);
    expect(JSON.stringify(res.body)).not.toContain('broken secret value');
  });

  it('tests the app credentials and signing keys read-only', async () => {
    const before = calls.length;
    const res = await h.http().post(`/v1/channels/${channel.id}/test`).set(auth(admin)).expect(200);
    expect(res.body.checks.slice(0, 2)).toEqual([
      { name: 'App credentials', ok: true, detail: `Microsoft Entra issued a Bot Connector token for app ${APP_ID} (tenant ${TENANT})` },
      { name: 'Signing keys', ok: true, detail: expect.stringContaining('1 Bot Framework signing key') },
    ]);
    // The test server's public URL is http, which Azure Bot Service cannot call.
    expect(res.body.checks[2]).toMatchObject({ name: 'Messaging endpoint', ok: false });
    expect(calls.slice(before).some((c) => c.path.includes('/v3/conversations/'))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain(APP_PASSWORD);
  });
});

describe('Microsoft Teams webhook', () => {
  it('rejects unsigned, expired, wrong-audience and re-pointed activities and stores nothing', async () => {
    const body = activity('1790244000001');
    await post(body, 401, null);
    await post(body, 401, await connectorJwt({ exp: Math.floor(Date.now() / 1000) - 600 }));
    await post(body, 403, await connectorJwt({ aud: '00000000-0000-4000-8000-000000000000' }));
    // The token binds the service URL: a body naming another one (where OCSO would send its token) is refused.
    await post({ ...body, serviceUrl: 'https://smba.trafficmanager.net/emea/' }, 403);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key LIKE 'teams:%:1790244000001'`);
    expect(rows[0].n).toBe(0);
  });

  it('persists a personal chat message once (Bot Connector retries carry the same id), and the reply goes back to that chat', async () => {
    const body = activity('1790244000100');
    const first = await post(body, 200);
    expect(first.text).toBe('');
    await post(body, 200);
    const { conversationId, replyContext } = await inbound('1790244000100');
    expect(replyContext).toEqual({ serviceUrl, conversationId: PERSONAL, conversationType: 'personal', tenantId: TENANT, botId: BOT_ID });
    const identity = await h.db.pool.query(`SELECT value FROM customer_identities WHERE kind = 'teams_user'`);
    expect(identity.rows.map((r: { value: string }) => r.value)).toEqual([`${TENANT}:${USER_AAD}`]);

    const reply = await agentReplies(conversationId, [{ type: 'TEXT', text: '## Update\nIt was dispatched **today**.' }]);
    const sent = connectorPosts().at(-1)!;
    expect(sent.path).toBe(`/amer/v3/conversations/${encodeURIComponent(PERSONAL)}/activities`);
    expect(sent.auth).toMatch(/^Bearer connector-token-\d+$/);
    expect(JSON.parse(sent.body)).toEqual({ type: 'message', conversation: { id: PERSONAL }, from: { id: BOT_ID }, textFormat: 'markdown', text: '**Update**\nIt was dispatched **today**.' });
    const { rows } = await h.db.pool.query(`SELECT delivery_status, external_message_id FROM interactions WHERE id = $1`, [reply]);
    expect(rows[0]).toMatchObject({ delivery_status: 'SENT', external_message_id: expect.stringMatching(/^teams:[0-9a-f]{24}:1790245000\d{3}$/) });
  });

  it('answers an @mention in its channel thread, offers choices as an Adaptive Card, and takes a tap back as a structured reply', async () => {
    const mention = activity('1790244500000', {
      conversation: { id: CHANNEL_THREAD, conversationType: 'channel', tenantId: TENANT, isGroup: true },
      text: '<at>OCSO Assistant</at> I need help with a charge',
      textFormat: 'xml',
      entities: [{ type: 'mention', text: '<at>OCSO Assistant</at>', mentioned: { id: BOT_ID, name: 'OCSO Assistant' } }],
    });
    await post(mention, 200);
    const { conversationId, replyContext } = await inbound('1790244500000');
    expect(replyContext).toEqual({ serviceUrl, conversationId: CHANNEL_THREAD, conversationType: 'channel', tenantId: TENANT, botId: BOT_ID });
    const parts = await h.db.pool.query(`SELECT content FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id WHERE i.channel_id = $1 AND i.idempotency_key LIKE 'teams:%:1790244500000'`, [channel.id]);
    expect(parts.rows[0].content).toEqual({ type: 'TEXT', text: 'I need help with a charge' });

    const choice = { type: 'STRUCTURED', schema: 'ocso.choices', data: { text: 'Which product?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] }, fallbackText: 'Which product?\n\n1. Cards\n2. Loans' };
    await agentReplies(conversationId, [choice]);
    const sent = connectorPosts().at(-1)!;
    expect(sent.path).toBe(`/amer/v3/conversations/${encodeURIComponent(CHANNEL_THREAD)}/activities`);
    const card = (JSON.parse(sent.body) as { attachments: Array<{ contentType: string; content: { actions: Array<{ title: string; data: Record<string, string> }> } }> }).attachments[0]!;
    expect(card.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(card.content.actions.map((a) => a.data)).toEqual([
      { ocso: 'choice', id: 'cards', label: 'Cards', for: USER_AAD },
      { ocso: 'choice', id: 'loans', label: 'Loans', for: USER_AAD },
    ]);

    // Action.Submit posts a message activity whose value is the button's data; a bystander's tap is ignored.
    const tap = (id: string, aad: string) =>
      activity(id, { conversation: { id: CHANNEL_THREAD, conversationType: 'channel', tenantId: TENANT }, from: { id: `29:${aad.slice(0, 6)}`, aadObjectId: aad }, text: undefined, value: card.content.actions[1]!.data, replyToId: '1790245000002' });
    await post(tap('1790244600001', BYSTANDER_AAD), 200);
    await post(tap('1790244600002', USER_AAD), 200);
    const { rows } = await h.db.pool.query(
      `SELECT i.conversation_id, i.idempotency_key, p.content FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id WHERE i.channel_id = $1 AND i.idempotency_key LIKE 'teams:%:17902446%'`,
      [channel.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversation_id: conversationId,
      idempotency_key: expect.stringMatching(/:1790244600002$/),
      content: { type: 'STRUCTURED', schema: 'button_reply', data: { id: 'loans', title: 'Loans', source: 'teams' }, fallbackText: 'Loans' },
    });
  });

  it('answers a personal chat in that chat even when the person @mentions the bot in a channel before the reply goes out', async () => {
    await post(activity('1790244700001', { text: 'What is my balance?' }), 200);
    await post(activity('1790244700002', {
        conversation: { id: CHANNEL_THREAD, conversationType: 'channel', tenantId: TENANT },
        text: '<at>OCSO Assistant</at> also, branch hours?',
        entities: [{ type: 'mention', text: '<at>OCSO Assistant</at>', mentioned: { id: BOT_ID } }],
      }), 200);
    const dm = await inbound('1790244700001');
    const thread = await inbound('1790244700002');
    expect(dm.conversationId).toBe(thread.conversationId);
    await agentReplies(dm.conversationId, [{ type: 'TEXT', text: 'Your balance is 1,024.00.' }], dm.seq);
    expect(connectorPosts().at(-1)!.path).toBe(`/amer/v3/conversations/${encodeURIComponent(PERSONAL)}/activities`);
    await agentReplies(dm.conversationId, [{ type: 'TEXT', text: 'We open at 9.' }], thread.seq);
    expect(connectorPosts().at(-1)!.path).toBe(`/amer/v3/conversations/${encodeURIComponent(CHANNEL_THREAD)}/activities`);
  });

  it('acknowledges conversationUpdate and typing activities without storing them', async () => {
    await post(activity('1790244800001', { type: 'conversationUpdate', text: undefined, membersAdded: [{ id: BOT_ID }] }), 200);
    await post(activity('1790244800002', { type: 'typing', text: undefined }), 200);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key LIKE 'teams:%:17902448%'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('Ask OCSO over Microsoft Teams', () => {
  const STAFF_AAD = '4b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e';
  const STAFF_PERSONAL = 'a:1Xk9-staff-personal-conversation';
  const STAFF_THREAD = '19:staff000thread@thread.tacv2;messageid=1790246000000';
  const staff = (id: string, overrides: Record<string, unknown> = {}) => activity(id, { from: { id: '29:1staff', name: 'Sam Staff', aadObjectId: STAFF_AAD }, ...overrides });
  const inThread = (id: string, text: string) =>
    staff(id, {
      conversation: { id: STAFF_THREAD, conversationType: 'channel', tenantId: TENANT, isGroup: true },
      text: `<at>OCSO Assistant</at> ${text}`,
      textFormat: 'xml',
      entities: [{ type: 'mention', text: '<at>OCSO Assistant</at>', mentioned: { id: BOT_ID, name: 'OCSO Assistant' } }],
    });
  const inPersonal = (id: string, text: string) => staff(id, { conversation: { id: STAFF_PERSONAL, conversationType: 'personal', tenantId: TENANT }, text });
  const say = async (body: unknown) => {
    await post(body, 200, undefined, askChannel);
    await h.app.get(StaffChatService).idle();
  };
  const sentTo = (conversation: string, since: number) => connectorPosts().slice(since).filter((c) => c.path === `/amer/v3/conversations/${encodeURIComponent(conversation)}/activities`);
  const textOf = (call: { body: string }) => String((JSON.parse(call.body) as { text?: string }).text ?? '');
  const tokenIn = (text: string) => /\/link\/([A-Za-z0-9_-]{43})/.exec(text)?.[1] ?? null;

  it('never posts the one-time link into a channel thread: the thread hears to message the bot 1:1', async () => {
    const before = connectorPosts().length;
    await say(inThread('1790246000000', 'what needs me today?'));
    const posted = connectorPosts().slice(before);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe(`/amer/v3/conversations/${encodeURIComponent(STAFF_THREAD)}/activities`);
    expect(textOf(posted[0]!)).toContain('message me directly');
    expect(textOf(posted[0]!)).not.toContain('/link/');
    // Nobody holds that link, so none is kept (and the 1:1 message below gets one at once).
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_link_tokens WHERE channel_id = $1`, [askChannel.id]);
    expect(rows[0].n).toBe(0);
  });

  it('sends the link in the personal chat, and after linking keeps one Ask OCSO thread per chat', async () => {
    let before = connectorPosts().length;
    await say(inPersonal('1790246100001', 'hello'));
    const [linkPost] = sentTo(STAFF_PERSONAL, before);
    const token = tokenIn(textOf(linkPost!));
    expect(token).not.toBeNull();
    expect(connectorPosts().slice(before)).toHaveLength(1);

    // An @mention in the thread now that OCSO knows the personal chat: the new link goes there, never to the thread.
    before = connectorPosts().length;
    await say(inThread('1790246100002', 'hi again'));
    expect(sentTo(STAFF_THREAD, before)).toEqual([]);
    expect(sentTo(STAFF_PERSONAL, before).map((c) => tokenIn(textOf(c)))).toEqual([expect.stringMatching(/^[A-Za-z0-9_-]{43}$/)]);

    // Confirming on the page only claims the link: the code it shows must come back from this Teams account.
    const claimed = await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(lead)).send({ token }).expect(200);
    expect(claimed.body).toMatchObject({ link: null, existing: false, code: expect.stringMatching(/^\d{6}$/) });
    await expect.poll(() => sentTo(STAFF_PERSONAL, before).some((c) => textOf(c).startsWith('Almost linked'))).toBe(true);
    expect(connectorPosts().some((c) => c.body.includes(claimed.body.code))).toBe(false);
    before = connectorPosts().length;
    await say(inPersonal('1790246100010', claimed.body.code));
    expect(sentTo(STAFF_PERSONAL, before).map(textOf)).toEqual(['Linked. Ask me anything.']);

    // Two personal messages in a row continue one thread; the channel thread is another.
    await say(inPersonal('1790246100003', 'first question'));
    await say(inPersonal('1790246100004', 'and the second one?'));
    await say(inThread('1790246100005', 'a thread question'));
    const threads = await h.db.pool.query(
      `SELECT t.title FROM internal_agent_threads t JOIN channel_account_links l ON l.id = t.channel_link_id WHERE l.channel_id = $1 AND t.user_id = $2 ORDER BY t.title`,
      [askChannel.id, leadId],
    );
    expect(threads.rows.map((r: { title: string }) => r.title)).toEqual(['a thread question', 'first question']);
    // Teams threads (and the audit rows of what they do) are marked with the descriptor's surface, `teams`.
    const surfaces = await h.db.pool.query(`SELECT DISTINCT surface FROM internal_agent_threads WHERE user_id = $1 AND channel_link_id IS NOT NULL`, [leadId]);
    expect(surfaces.rows).toEqual([{ surface: 'teams' }]);
  });

  it('a direct card is confirmed by its Adaptive Card button from the same Teams account only', async () => {
    const teamId = (await h.db.pool.query(`SELECT id FROM teams WHERE name = 'Cards'`)).rows[0].id as string;
    const call = `[[call:execute_tool ${JSON.stringify({ name: 'users.update_team', args: { id: teamId, name: 'Cards Desk' } })}]]`;
    let before = connectorPosts().length;
    await say(inPersonal('1790246200001', call));
    const [cardPost] = sentTo(STAFF_PERSONAL, before).filter((c) => c.body.includes('AdaptiveCard'));
    const card = (JSON.parse(cardPost!.body) as { attachments: Array<{ content: { actions: Array<{ data: { ocso: string; id: string; label: string } }> } }> }).attachments[0]!.content;
    const confirm = card.actions.find((a) => a.data.id.endsWith(':confirm'))!.data;
    const cardId = confirm.id.split(':')[1]!;
    const tap = (id: string, from: Record<string, unknown>) => staff(id, { from, conversation: { id: STAFF_PERSONAL, conversationType: 'personal', tenantId: TENANT }, text: undefined, value: confirm });

    // Someone else's Teams account (not linked) tapping the same button changes nothing.
    await say(tap('1790246200002', { id: '29:1bystander', name: 'By Stander', aadObjectId: BYSTANDER_AAD }));
    expect((await h.db.pool.query(`SELECT status FROM internal_agent_actions WHERE id = $1`, [cardId])).rows[0].status).toBe('PENDING');

    before = connectorPosts().length;
    await say(tap('1790246200003', { id: '29:1staff', name: 'Sam Staff', aadObjectId: STAFF_AAD }));
    expect((await h.db.pool.query(`SELECT status FROM internal_agent_actions WHERE id = $1`, [cardId])).rows[0].status).toBe('EXECUTED');
    expect(sentTo(STAFF_PERSONAL, before).map(textOf).join('\n')).toMatch(/^Done: Update team · Cards\./);
    const audit = await h.db.pool.query(`SELECT actor_id, via, confirmation FROM audit_events WHERE confirmation->'internalAgent'->>'cardId' = $1`, [cardId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(1);
    for (const row of audit.rows) expect(row).toMatchObject({ actor_id: leadId, via: 'INTERNAL_AGENT', confirmation: { internalAgent: { surface: 'teams' } } });
  });
});
