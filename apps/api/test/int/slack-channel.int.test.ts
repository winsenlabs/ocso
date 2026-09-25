import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelRuntime, DeliveryService } from '@ocso/agent-runtime';
import { appendInteraction } from '@ocso/application';
import type { BlobStore } from '@ocso/blob';
import { modelProfiles, modelProviders, turns, uuidv7 } from '@ocso/db';
import { BLOB_STORE } from '../../src/infrastructure/tokens.js';
import { liveChannel } from './platform.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';
import { routeChannel } from './routing.js';

/**
 * Slack over the real API: the Slack descriptor (settings, write-only secrets, app manifest), creation and
 * activation by approval, `/channels/slack/<publicKey>/webhook` with X-Slack-Signature verification,
 * url_verification, persist-once ingress keyed on event_id, the reply context stored with the inbound message,
 * and delivery of the agent's reply back into the same Slack thread through a fake Slack Web API.
 */

const SIGNING_SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const BOT_TOKEN = 'xoxb-fake-test-token-02';
const TEAM = 'T0MERIDIAN';
const USER = 'U0CUSTOMER';
const BOT = 'U0OCSOBOT1';
const CHANNEL = 'C0SUPPORT1';
const DM = 'D0CUSTDM01';

let h: ApiHarness;
let admin: string;
let stub: Server;
let stubUrl: string;
const slackCalls: Array<{ method: string; auth: string | undefined; body: Record<string, unknown> }> = [];
let channel: { id: string; publicKey: string; webhookPath: string };
let agentId: string;
let posts = 0;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const now = () => String(Math.floor(Date.now() / 1000));
const sign = (body: string, ts = now(), secret = SIGNING_SECRET) => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
const post = (body: string, options: { signature?: string; ts?: string; form?: boolean } = {}) => {
  const ts = options.ts ?? now();
  return h
    .http()
    .post(channel.webhookPath)
    .set('content-type', options.form ? 'application/x-www-form-urlencoded' : 'application/json')
    .set('x-slack-request-timestamp', ts)
    .set('x-slack-signature', options.signature ?? sign(body, ts))
    .send(body);
};

const event = (eventId: string, inner: Record<string, unknown>) =>
  JSON.stringify({ type: 'event_callback', team_id: TEAM, api_app_id: 'A0OCSO', event_id: eventId, event_time: 1790244000, authorizations: [{ team_id: TEAM, user_id: BOT, is_bot: true }], event: inner });

async function conversationOf(externalId: string): Promise<{ conversationId: string; replyContext: Record<string, string> | null }> {
  const { rows } = await h.db.pool.query(`SELECT conversation_id, reply_context FROM interactions WHERE channel_id = $1 AND idempotency_key = $2`, [channel.id, externalId]);
  expect(rows).toHaveLength(1);
  return { conversationId: rows[0].conversation_id, replyContext: rows[0].reply_context };
}

/** The agent's reply (what a turn persists; `answersSeq` = the turn's input, turns.seq_to), then the worker's channel.deliver job. */
async function agentReplies(conversationId: string, parts: unknown[], answersSeq?: number): Promise<string> {
  let turnId: string | undefined;
  if (answersSeq !== undefined) {
    turnId = uuidv7();
    await h.db.db.insert(turns).values({ id: turnId, conversationId, agentId, workerId: 'slack-int', leaseVersion: 1, seqFrom: answersSeq, seqTo: answersSeq, status: 'COMPLETED', outcome: 'REPLIED' });
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
  expect(await delivery.deliver(interactionId, `slack-${interactionId}`)).toEqual({ kind: 'sent' });
  return interactionId;
}

beforeAll(async () => {
  // A local stand-in for slack.com/api: auth.test and chat.postMessage, recording every call.
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\/api\//, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      slackCalls.push({ method, auth: req.headers.authorization, body });
      const reply = (status: number, json: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return reply(200, { ok: false, error: 'invalid_auth' });
      if (method === 'auth.test') return reply(200, { ok: true, team: 'Meridian', team_id: TEAM, user: 'ocso', user_id: BOT, bot_id: 'B0OCSO' }, { 'x-oauth-scopes': 'app_mentions:read,chat:write,im:history,users:read,users:read.email' });
      if (method === 'chat.postMessage') {
        posts += 1;
        return reply(200, { ok: true, channel: body['channel'], ts: `1790245000.${String(posts).padStart(6, '0')}` });
      }
      return reply(200, { ok: false, error: 'unknown_method' });
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api`;

  h = await startApi();
  admin = await completeSetup(h);
  await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ egressAllowedInternalHosts: ['127.0.0.1'], approval: { bootstrap: true, reason: 'Sole Tech: local Slack stub' } }).expect(202);
  const leadId = (await h.http().post('/v1/users').set(auth(admin)).send({ email: 'lead@ocso.test', name: 'lead', role: 'HEAD', password: 'a password 12345' }).expect(201)).body.id as string;
  const lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [team]);
  const queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'support-primary', providerId: provider, model: 'scripted', retries: 0 });
  agentId = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queue, teamIds: [team] }).expect(201)).body.id;

  const created = await liveChannel<{ id: string; publicKey: string; webhookPath: string }>(h, admin, { id: leadId, token: lead }, {
    kind: 'SLACK',
    name: 'Meridian Slack',
    settings: { respondTo: 'dm_and_mentions', replyInThread: true, apiBaseUrl: stubUrl },
    secrets: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
  });
  expect(JSON.stringify(created)).not.toContain(BOT_TOKEN);
  expect(JSON.stringify(created)).not.toContain(SIGNING_SECRET);
  channel = created;
  // channel → pass-through router → Maya's queue.
  await routeChannel(h, channel.id, agentId, queue);
});

afterAll(async () => {
  await h?.close();
  await new Promise((resolve) => stub?.close(resolve));
});

describe('Slack channel kind', () => {
  it('is served to the admin form with its settings, write-only secrets and app manifest', async () => {
    const kinds = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    const slack = kinds.body.find((k: { kind: string }) => k.kind === 'SLACK');
    expect(slack).toMatchObject({ label: 'Slack', mark: { code: 'SL' }, inboundWebhook: true, webhookSegment: 'slack', connectionCheck: true, messageTemplates: false });
    expect(slack.secrets.map((s: { key: string }) => s.key)).toEqual(['botToken', 'signingSecret']);
    expect(slack.setupFiles.map((f: { key: string; contentType: string }) => [f.key, f.contentType])).toEqual([
      ['slack-app-manifest-yaml', 'text/yaml'],
      ['slack-app-manifest', 'application/json'],
    ]);
    expect(slack.setupFiles[1].template).toContain('"request_url": "{{webhookUrl}}"');
    expect(slack.setupGuide.find((s: { form?: boolean }) => s.form)).toMatchObject({ title: 'Paste them into OCSO and save' });
    expect(channel.webhookPath).toBe(`/channels/slack/${channel.publicKey}/webhook`);
  });

  it('creates a draft before the Slack app exists: the manifest downloads with its webhook URL, and the URL check passes once the signing secret is saved', async () => {
    const draft = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'SLACK', name: 'Slack draft', settings: {}, secrets: {} }).expect(201);
    const url = `http://localhost:3000${draft.body.webhookPath}`;
    const yaml = await h.http().get(`/v1/channels/${draft.body.id}/setup-files/slack-app-manifest-yaml`).set(auth(admin)).expect(200);
    expect(yaml.headers['content-type']).toBe('text/yaml; charset=utf-8');
    expect(yaml.headers['content-disposition']).toBe('attachment; filename="slack-app-manifest.yaml"');
    expect(yaml.text).toContain(`request_url: ${url}`);
    const json = await h.http().get(`/v1/channels/${draft.body.id}/setup-files/slack-app-manifest`).set(auth(admin)).expect(200);
    expect(JSON.parse(json.text)).toMatchObject({ settings: { event_subscriptions: { request_url: url }, interactivity: { request_url: url } } });
    // Without a signing secret nothing Slack sends is accepted, not even the URL check.
    const challenge = JSON.stringify({ token: 'legacy', type: 'url_verification', challenge: 'draftChallenge1' });
    const at = draft.body.webhookPath as string;
    const send = () => h.http().post(at).set('content-type', 'application/json').set('x-slack-request-timestamp', now()).set('x-slack-signature', sign(challenge)).send(challenge);
    await send().expect(403);
    await h.http().patch(`/v1/channels/${draft.body.id}`).set(auth(admin)).send({ secrets: { signingSecret: SIGNING_SECRET } }).expect(200);
    const answered = await send().expect(200);
    expect(answered.text).toBe('draftChallenge1');
    // A given value is still checked on a draft.
    await h.http().patch(`/v1/channels/${draft.body.id}`).set(auth(admin)).send({ secrets: { botToken: 'xoxp-user-token-1234567890' } }).expect(400);
  });

  it('refuses an invalid configuration', async () => {
    const res = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'SLACK', name: 'Broken', settings: { respondTo: 'everyone' }, secrets: { botToken: 'xoxp-user-token-1234567890' } }).expect(400);
    expect(JSON.stringify(res.body)).not.toContain('xoxp-user-token-1234567890');
  });

  it('checks the bot token read-only with auth.test', async () => {
    const before = slackCalls.length;
    const res = await h.http().post(`/v1/channels/${channel.id}/test`).set(auth(admin)).expect(200);
    expect(res.body.checks.slice(0, 2)).toEqual([
      { name: 'Bot token', ok: true, detail: 'valid for "Meridian" as @ocso' },
      { name: 'Bot scopes', ok: true, detail: expect.stringContaining('chat:write') },
    ]);
    // The test server's public URL is http, which Slack cannot call.
    expect(res.body.checks[2]).toMatchObject({ name: 'Request URL' });
    expect(slackCalls.slice(before).map((c) => c.method)).toEqual(['auth.test']);
    expect(JSON.stringify(res.body)).not.toContain(BOT_TOKEN);
  });
});

describe('Slack webhook', () => {
  it('answers a signed url_verification with the challenge and stores nothing', async () => {
    const body = JSON.stringify({ token: 'legacy', type: 'url_verification', challenge: 'c7Hq2xYz09ABcd' });
    const res = await post(body).expect(200);
    expect(res.text).toBe('c7Hq2xYz09ABcd');
    await post(body, { signature: sign(body, now(), 'wrong0secret0value0000') }).expect(403);
  });

  it('rejects stale, tampered and unsigned requests and stores nothing', async () => {
    const body = event('Ev0REJECTED', { type: 'message', channel_type: 'im', channel: DM, user: USER, text: 'hi', ts: '1790244000.000001' });
    const stale = String(Number(now()) - 600);
    await post(body, { ts: stale, signature: sign(body, stale) }).expect(401);
    await post(body, { signature: sign(body.replace('hi', 'bye')) }).expect(403);
    await post(body, { signature: 'v0=' }).expect(401);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = 'Ev0REJECTED'`);
    expect(rows[0].n).toBe(0);
  });

  it('persists a DM once (Slack retries carry the same event_id) with an empty 200, and the reply goes back to the DM', async () => {
    const body = event('Ev0DM000001', { type: 'message', channel_type: 'im', channel: DM, user: USER, team: TEAM, text: 'Where is my new card?', ts: '1790244000.000100' });
    const first = await post(body).expect(200);
    expect(first.text).toBe('');
    await post(body).expect(200);
    const { conversationId, replyContext } = await conversationOf('Ev0DM000001');
    expect(replyContext).toEqual({ teamId: TEAM, channel: DM });
    const identity = await h.db.pool.query(`SELECT value FROM customer_identities WHERE kind = 'slack_user'`);
    expect(identity.rows.map((r: { value: string }) => r.value)).toEqual([`${TEAM}:${USER}`]);

    const reply = await agentReplies(conversationId, [{ type: 'TEXT', text: 'It was dispatched **today**.' }]);
    const sent = slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    expect(sent.auth).toBe(`Bearer ${BOT_TOKEN}`);
    expect(sent.body).toEqual({ channel: DM, text: 'It was dispatched *today*.', mrkdwn: true, unfurl_links: false, unfurl_media: false });
    const { rows } = await h.db.pool.query(`SELECT delivery_status, external_message_id, reply_context FROM interactions WHERE id = $1`, [reply]);
    expect(rows[0]).toMatchObject({ delivery_status: 'SENT', external_message_id: expect.stringMatching(new RegExp(`^${DM}:1790245000\\.`)), reply_context: null });
  });

  it('answers an @mention in a thread under it, offers choices as buttons, and takes a tap back as a structured reply', async () => {
    const body = event('Ev0MENTION01', { type: 'app_mention', channel: CHANNEL, user: USER, team: TEAM, text: `<@${BOT}> I need help with a charge`, ts: '1790244500.000200' });
    await post(body).expect(200);
    const { conversationId, replyContext } = await conversationOf('Ev0MENTION01');
    expect(replyContext).toEqual({ teamId: TEAM, channel: CHANNEL, threadTs: '1790244500.000200' });
    const parts = await h.db.pool.query(`SELECT content FROM interaction_parts p JOIN interactions i ON i.id = p.interaction_id WHERE i.idempotency_key = 'Ev0MENTION01'`);
    expect(parts.rows[0].content).toEqual({ type: 'TEXT', text: 'I need help with a charge' });

    const choice = { type: 'STRUCTURED', schema: 'ocso.choices', data: { text: 'Which product?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] }, fallbackText: 'Which product?\n\n1. Cards\n2. Loans' };
    await agentReplies(conversationId, [choice]);
    const sent = slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    expect(sent.body).toMatchObject({ channel: CHANNEL, thread_ts: '1790244500.000200', text: 'Which product?\n\n1. Cards\n2. Loans' });
    const actions = (sent.body['blocks'] as Array<{ type: string; block_id?: string; elements?: Array<{ action_id: string; value: string; text: { text: string } }> }>)[1]!;
    const buttons = actions.elements!;
    expect(buttons.map((b) => b.action_id)).toEqual(['ocso.choice:cards', 'ocso.choice:loans']);
    // Addressed to the customer asked: another member of the channel cannot answer for them.
    expect(actions.block_id).toBe(`ocso.choices:${USER}`);

    const messageTs = String(posts).padStart(6, '0');
    const tap = {
      type: 'block_actions',
      team: { id: TEAM },
      user: { id: USER, team_id: TEAM, username: 'asha' },
      container: { type: 'message', channel_id: CHANNEL, message_ts: `1790245000.${messageTs}`, thread_ts: '1790244500.000200' },
      message: { ts: `1790245000.${messageTs}`, thread_ts: '1790244500.000200' },
      actions: [{ type: 'button', block_id: actions.block_id, action_id: buttons[1]!.action_id, value: buttons[1]!.value, text: { type: 'plain_text', text: 'Loans' }, action_ts: '1790245010.000001' }],
    };
    const form = new URLSearchParams({ payload: JSON.stringify(tap) }).toString();
    const bystander = new URLSearchParams({ payload: JSON.stringify({ ...tap, user: { id: 'U0BYSTANDR', team_id: TEAM, username: 'ravi' } }) }).toString();
    await post(bystander, { form: true }).expect(200);
    await post(form, { form: true }).expect(200);
    const { rows } = await h.db.pool.query(
      `SELECT i.conversation_id, i.reply_context, p.content FROM interactions i JOIN interaction_parts p ON p.interaction_id = i.id WHERE i.channel_id = $1 AND i.idempotency_key LIKE 'action:%'`,
      [channel.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      conversation_id: conversationId,
      reply_context: { teamId: TEAM, channel: CHANNEL, threadTs: '1790244500.000200' },
      content: { type: 'STRUCTURED', schema: 'button_reply', data: { id: 'loans', title: 'Loans', source: 'slack' }, fallbackText: 'Loans' },
    });
  });

  it('answers a DM in the DM even when the customer @mentions the app in a channel before the reply goes out', async () => {
    await post(event('Ev0DMPRIV01', { type: 'message', channel_type: 'im', channel: DM, user: USER, team: TEAM, text: 'What is my balance?', ts: '1790244700.000001' })).expect(200);
    await post(event('Ev0MENTION02', { type: 'app_mention', channel: CHANNEL, user: USER, team: TEAM, text: `<@${BOT}> also, branch hours?`, ts: '1790244700.000200' })).expect(200);
    const { rows } = await h.db.pool.query(`SELECT conversation_id, seq, idempotency_key FROM interactions WHERE channel_id = $1 AND idempotency_key IN ('Ev0DMPRIV01', 'Ev0MENTION02') ORDER BY seq`, [channel.id]);
    expect(rows.map((r: { idempotency_key: string }) => r.idempotency_key)).toEqual(['Ev0DMPRIV01', 'Ev0MENTION02']);
    expect(rows[0].conversation_id).toBe(rows[1].conversation_id);
    const conversationId = rows[0].conversation_id as string;

    // The turn that answers the DM (its input ends at the DM) posts in the DM, not the public thread.
    await agentReplies(conversationId, [{ type: 'TEXT', text: 'Your balance is 1,024.00.' }], rows[0].seq);
    const dmReply = slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    expect(dmReply.body).toMatchObject({ channel: DM, text: 'Your balance is 1,024.00.' });
    expect(dmReply.body).not.toHaveProperty('thread_ts');

    // The next turn answers the mention in its thread.
    await agentReplies(conversationId, [{ type: 'TEXT', text: 'We open at 9.' }], rows[1].seq);
    expect(slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1)!.body).toMatchObject({ channel: CHANNEL, thread_ts: '1790244700.000200' });
  });

  it('counts bot messages and edits as ignored without storing them', async () => {
    const bot = event('Ev0BOTMSG01', { type: 'message', subtype: 'bot_message', bot_id: 'B0OCSO', channel_type: 'im', channel: DM, text: 'echo', ts: '1790244600.000001' });
    const edit = event('Ev0EDIT0001', { type: 'message', subtype: 'message_changed', channel_type: 'im', channel: DM, ts: '1790244600.000002' });
    await post(bot).expect(200);
    await post(edit).expect(200);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key IN ('Ev0BOTMSG01', 'Ev0EDIT0001')`);
    expect(rows[0].n).toBe(0);
  });
});
