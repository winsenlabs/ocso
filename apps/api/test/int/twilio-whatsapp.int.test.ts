import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';

/**
 * WhatsApp via Twilio over the real API: plugin-driven channel kinds, the
 * generic `/channels/:segment/:publicKey/webhook` route, X-Twilio-Signature
 * over the public URL + form parameters, persist-once ingress, TwiML ack,
 * and the read-only connection check (against a local Twilio stub).
 */

const ACCOUNT_SID = 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90';
const AUTH_TOKEN = '3f9c2b7a1e8d4c6b0a5f9e2d7c1b8a46';
const MESSAGE_SID = 'SM2f6c1e0b9a8d7c6b5a4f3e2d1c0b9a8f';

let h: ApiHarness;
let admin: string;
let stub: Server;
let stubUrl: string;
let stubCalls = 0;
let channel: { id: string; publicKey: string; webhookPath: string };
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

function sign(url: string, params: Record<string, string>, token = AUTH_TOKEN): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', token).update(Buffer.from(data, 'utf-8')).digest('base64');
}

const inbound = (overrides: Record<string, string> = {}): Record<string, string> => ({
  SmsMessageSid: MESSAGE_SID,
  NumMedia: '0',
  ProfileName: 'Priya Deshmukh',
  WaId: '919812341208',
  SmsStatus: 'received',
  Body: 'My card was charged twice',
  To: 'whatsapp:+14155238886',
  NumSegments: '1',
  MessageSid: MESSAGE_SID,
  AccountSid: ACCOUNT_SID,
  From: 'whatsapp:+919812341208',
  ApiVersion: '2010-04-01',
  ...overrides,
});

beforeAll(async () => {
  // A local stand-in for api.twilio.com: only the read-only account fetch the Test button uses.
  stub = createServer((req, res) => {
    stubCalls++;
    const ok = req.method === 'GET' && req.url === `/2010-04-01/Accounts/${ACCOUNT_SID}.json` && req.headers.authorization === `Basic ${Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString('base64')}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { sid: ACCOUNT_SID, friendly_name: 'Meridian Bank', status: 'active' } : { code: 20003, message: 'Authenticate', status: 401 }));
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;

  h = await startApi();
  admin = await completeSetup(h);
  // Channel adapters reach only public https hosts unless the Tech admin allowlists an internal one (ADR-021).
  await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ egressAllowedInternalHosts: ['127.0.0.1'] }).expect(200);
  const leadId = (await h.http().post('/v1/users').set(auth(admin)).send({ email: 'lead@ocso.test', name: 'lead', role: 'HEAD', password: 'a password 12345' }).expect(201)).body.id as string;
  const lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Cards' }).expect(201)).body.id;
  // Agents are owned by teams (ADR-026): the lead must belong to the owning team.
  await setTeams(h, admin, leadId, [team]);
  const queue = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Cards', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'support-primary', providerId: provider, model: 'scripted', retries: 0 });
  const agent = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queue, teamIds: [team] }).expect(201)).body.id;

  const created = await h
    .http()
    .post('/v1/channels')
    .set(auth(admin))
    .send({
      kind: 'TWILIO_WHATSAPP',
      name: 'WhatsApp (Twilio)',
      status: 'ACTIVE',
      defaultAgentId: agent,
      settings: { accountSid: ACCOUNT_SID, from: 'whatsapp:+14155238886', apiBaseUrl: stubUrl },
      secrets: { authToken: AUTH_TOKEN },
    })
    .expect(201);
  channel = created.body;
  expect(JSON.stringify(created.body)).not.toContain(AUTH_TOKEN);
});

afterAll(async () => {
  await h?.close();
  await new Promise((resolve) => stub?.close(resolve));
});

const publicOrigin = () => new URL(process.env['OCSO_PUBLIC_URL'] ?? 'http://localhost:3000').origin;
const post = (params: Record<string, string>, signature: string, path = channel.webhookPath) =>
  h.http().post(path).set('content-type', 'application/x-www-form-urlencoded').set('x-twilio-signature', signature).send(new URLSearchParams(params).toString());

describe('channel kinds are plugins', () => {
  it('lists Twilio first as "WhatsApp — Twilio", with its webhook segment and a connection check', async () => {
    const res = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    expect(res.body.map((k: { kind: string }) => k.kind)).toEqual(['TWILIO_WHATSAPP', 'WHATSAPP', 'WEBCHAT']);
    expect(res.body[0]).toMatchObject({ label: 'WhatsApp — Twilio', inboundWebhook: true, webhookSegment: 'twilio-whatsapp', connectionCheck: true });
    expect(res.body[1]).toMatchObject({ label: 'WhatsApp — Meta Cloud API', webhookSegment: 'whatsapp', connectionCheck: false });
  });

  it('derives the webhook path from the descriptor and refuses kinds without an adapter', async () => {
    expect(channel.webhookPath).toBe(`/channels/twilio-whatsapp/${channel.publicKey}/webhook`);
    expect(channel).toMatchObject({ embedPath: null });
    const res = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'SMS', name: 'SMS' }).expect(400);
    expect(res.body.error.code).toBe('unknown_channel_kind');
  });
});

describe('Twilio webhook', () => {
  it('persists a correctly signed inbound message exactly once and answers with empty TwiML', async () => {
    const params = inbound();
    const signature = sign(`${publicOrigin()}${channel.webhookPath}`, params);
    const first = await post(params, signature).expect(200);
    expect(first.headers['content-type']).toMatch(/^text\/xml/);
    expect(first.text).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    await post(params, signature).expect(200);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = $1`, [MESSAGE_SID]);
    expect(rows[0].n).toBe(1);
    const identity = await h.db.pool.query(`SELECT value FROM customer_identities WHERE kind = 'whatsapp_phone'`);
    expect(identity.rows.map((r: { value: string }) => r.value)).toEqual(['+919812341208']);
  });

  it('rejects a bad, tampered or wrong-URL signature and stores nothing', async () => {
    const params = inbound({ MessageSid: 'SM00000000000000000000000000000001', SmsMessageSid: 'SM00000000000000000000000000000001' });
    await post(params, Buffer.alloc(20).toString('base64')).expect(403);
    await post({ ...params, Body: 'tampered' }, sign(`${publicOrigin()}${channel.webhookPath}`, params)).expect(403);
    await post(params, sign(`http://api:4000${channel.webhookPath}`, params)).expect(403);
    await post(params, '').expect(401);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = 'SM00000000000000000000000000000001'`);
    expect(rows[0].n).toBe(0);
  });

  it('accepts status callbacks on the same URL; unknown segments and keys are 404; the Meta route is unchanged', async () => {
    const status = { MessageSid: 'SMa3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8', MessageStatus: 'delivered', SmsStatus: 'delivered', AccountSid: ACCOUNT_SID, To: 'whatsapp:+919812341208', From: 'whatsapp:+14155238886' };
    await post(status, sign(`${publicOrigin()}${channel.webhookPath}`, status)).expect(200);
    await post(status, 'x', `/channels/sms/${channel.publicKey}/webhook`).expect(404);
    await post(status, 'x', `/channels/whatsapp/${channel.publicKey}/webhook`).expect(404);
    await h.http().get(`/channels/twilio-whatsapp/${channel.publicKey}/webhook`).expect(400);
  });
});

describe('connection test', () => {
  it('reaches a private provider host only when the Tech admin allowlisted it (SSRF-guarded channel egress)', async () => {
    // Same stub, addressed as `localhost`: not on the allowlist, so the adapter's injected fetch refuses it.
    const unlisted = await h
      .http()
      .post('/v1/channels')
      .set(auth(admin))
      .send({ kind: 'TWILIO_WHATSAPP', name: 'WhatsApp (unlisted host)', status: 'ACTIVE', settings: { accountSid: ACCOUNT_SID, from: 'whatsapp:+14155238886', apiBaseUrl: stubUrl.replace('127.0.0.1', 'localhost') }, secrets: { authToken: AUTH_TOKEN } })
      .expect(201);
    const before = stubCalls;
    const blocked = await h.http().post(`/v1/channels/${unlisted.body.id}/test`).set(auth(admin)).expect(200);
    expect(blocked.body.checks[0]).toEqual({ name: 'Account SID + auth token', ok: false, detail: 'could not reach Twilio' });
    expect(stubCalls).toBe(before);
  });

  it('checks the stored credentials read-only against Twilio', async () => {
    const before = stubCalls;
    const res = await h.http().post(`/v1/channels/${channel.id}/test`).set(auth(admin)).expect(200);
    expect(res.body.checks[0]).toEqual({ name: 'Account SID + auth token', ok: true, detail: '"Meridian Bank" is active' });
    expect(JSON.stringify(res.body)).not.toContain(AUTH_TOKEN);
    expect(stubCalls).toBe(before + 1);
  });
});
