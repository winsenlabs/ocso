import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChannelRuntime, DeliveryService, templateProviderSource } from '@ocso/agent-runtime';
import { pollPendingTemplates } from '@ocso/application';
import type { BlobStore } from '@ocso/blob';
import { modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { BLOB_STORE } from '../../src/infrastructure/tokens.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { setTeams } from './teams.js';
import { seededContent, startTwilioStub, type TwilioStub } from './twilio-stub.js';

/**
 * Message templates (WhatsApp through Twilio) over the real API against a
 * local Twilio stub (Messages + Content API): the workspace list (cached),
 * the adapter's 24-hour window on the conversation and on free-form replies,
 * sending an approved template (validation, holder rule, idempotency,
 * reopen-and-send, delivery through the adapter), and the CS Lead create →
 * review → approved → sendable loop.
 */

const ACCOUNT_SID = 'ACa1b2c3d4e5f60718293a4b5c6d7e8f90';
const AUTH_TOKEN = '3f9c2b7a1e8d4c6b0a5f9e2d7c1b8a46';
const APPROVED = 'HX0f0e72ce92eef937d6f481b338ecbd19';
const PENDING = 'HX4f797bbf4c5ea0aeb6bf52c4572d788f';

let h: ApiHarness;
let stub: TwilioStub;
const tokens: Record<'admin' | 'lead' | 'otherLead' | 'exec' | 'exec2', string> = { admin: '', lead: '', otherLead: '', exec: '', exec2: '' };
const ids: Record<string, string> = {};
let conversationId: string;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const api = () => h.http();

function sign(url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', AUTH_TOKEN).update(Buffer.from(data, 'utf-8')).digest('base64');
}

async function inbound(body: string, messageSid: string): Promise<void> {
  const params = { MessageSid: messageSid, SmsMessageSid: messageSid, AccountSid: ACCOUNT_SID, From: 'whatsapp:+919812341208', To: 'whatsapp:+14155238886', Body: body, NumMedia: '0', ProfileName: 'Priya Deshmukh', WaId: '919812341208', SmsStatus: 'received' };
  const origin = new URL(process.env['OCSO_PUBLIC_URL'] ?? 'http://localhost:3000').origin;
  await api().post(ids.webhookPath!).set('content-type', 'application/x-www-form-urlencoded').set('x-twilio-signature', sign(`${origin}${ids.webhookPath}`, params)).send(new URLSearchParams(params).toString()).expect(200);
}

const templateMessage = (token: string, body: Record<string, unknown>) =>
  api().post(`/v1/conversations/${conversationId}/template-message`).set(auth(token)).send({ language: 'en', clientMessageId: randomUUID(), ...body });
const orderReady = { templateId: APPROVED, variables: { '1': 'Priya', '2': 'A-10423' } };
const closeWindow = () => h.db.pool.query(`UPDATE conversations SET last_customer_message_at = now() - interval '25 hours' WHERE id = $1`, [conversationId]);

beforeAll(async () => {
  stub = await startTwilioStub(ACCOUNT_SID, AUTH_TOKEN, [
    seededContent(APPROVED, 'order_ready_pickup', 'Hi {{1}}, your order {{2}} is ready for pickup at the front desk.', { '1': 'Priya', '2': 'A-10423' }, 'approved'),
    seededContent(PENDING, 'appointment_reminder', 'Hi {{1}}, this is a reminder of your appointment on {{2}}. Can you make it?', { '1': 'Sam', '2': 'Tuesday' }, 'pending'),
  ]);
  h = await startApi();
  tokens.admin = await completeSetup(h);
  // Channel adapters reach only public https hosts unless the Tech Admin allowlists an internal one (the stub is on loopback).
  await api().patch('/v1/settings/deployment').set(auth(tokens.admin)).send({ egressAllowedInternalHosts: ['127.0.0.1'] }).expect(200);
  const mk = async (email: string, role: string) => (await api().post('/v1/users').set(auth(tokens.admin)).send({ email, name: email.split('@')[0], role, password: 'a password 12345' }).expect(201)).body.id as string;
  const leadId = await mk('lead@ocso.test', 'CS_LEAD');
  const otherLeadId = await mk('other-lead@ocso.test', 'CS_LEAD');
  const execId = await mk('exec@ocso.test', 'CS_EXEC');
  const exec2Id = await mk('exec2@ocso.test', 'CS_EXEC');
  for (const [key, email] of [['lead', 'lead@ocso.test'], ['otherLead', 'other-lead@ocso.test'], ['exec', 'exec@ocso.test'], ['exec2', 'exec2@ocso.test']] as const) tokens[key] = await h.loginAs(email, 'a password 12345');
  ids.team = (await api().post('/v1/teams').set(auth(tokens.lead)).send({ name: 'Cards' }).expect(201)).body.id;
  ids.otherTeam = (await api().post('/v1/teams').set(auth(tokens.otherLead)).send({ name: 'Loans' }).expect(201)).body.id;
  for (const id of [leadId, execId, exec2Id]) await setTeams(h, tokens.admin, id, [ids.team!]);
  await setTeams(h, tokens.admin, otherLeadId, [ids.otherTeam!]);
  ids.execId = execId;
  ids.queue = (await api().post('/v1/queues').set(auth(tokens.lead)).send({ name: 'Cards', teamIds: [ids.team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'support-primary', providerId: provider, model: 'scripted', retries: 0 });
  const agent = (await api().post('/v1/agents').set(auth(tokens.lead)).send({ name: 'Maya', purpose: 'customer support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: ids.queue, teamIds: [ids.team] }).expect(201)).body.id;
  const channel = await api()
    .post('/v1/channels')
    .set(auth(tokens.admin))
    .send({ kind: 'TWILIO_WHATSAPP', name: 'WhatsApp (Twilio)', status: 'ACTIVE', defaultAgentId: agent, settings: { accountSid: ACCOUNT_SID, from: 'whatsapp:+14155238886', apiBaseUrl: stub.url, contentApiBaseUrl: stub.url }, secrets: { authToken: AUTH_TOKEN } })
    .expect(201);
  ids.channel = channel.body.id;
  ids.webhookPath = channel.body.webhookPath;

  await inbound('My card was charged twice', 'SM2f6c1e0b9a8d7c6b5a4f3e2d1c0b9a8f');
  conversationId = (await h.db.pool.query(`SELECT id FROM conversations LIMIT 1`)).rows[0].id;
  // Lead takes over, then hands it to the exec through the team queue (both execs can see it; one holds it).
  await api().post(`/v1/conversations/${conversationId}/take-over`).set(auth(tokens.lead)).expect(204);
  await api().post(`/v1/conversations/${conversationId}/transfer`).set(auth(tokens.lead)).send({ queueId: ids.queue, userId: execId }).expect(204);
  await api().post(`/v1/conversations/${conversationId}/accept`).set(auth(tokens.exec)).expect(204);
});

afterAll(async () => {
  await h?.close();
  await stub?.close();
});

describe('template list for the workspace', () => {
  it('lists the provider templates with approval state; cached ~5 minutes, ?refresh=true refetches', async () => {
    const before = stub.requests.filter((r) => r.path.startsWith('/v1/ContentAndApprovals')).length;
    const res = await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.exec)).expect(200);
    expect(res.body.channel).toMatchObject({ id: ids.channel, kind: 'TWILIO_WHATSAPP' });
    expect(res.body.problem).toBeNull();
    expect(res.body.templates.map((t: { name: string; status: string; category: string }) => [t.name, t.status, t.category])).toEqual([
      ['appointment_reminder', 'PENDING', 'UTILITY'],
      ['order_ready_pickup', 'APPROVED', 'UTILITY'],
    ]);
    await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.exec)).expect(200);
    const listCalls = () => stub.requests.filter((r) => r.path.startsWith('/v1/ContentAndApprovals')).length;
    expect(listCalls()).toBe(before + 1);
    await api().get(`/v1/channels/${ids.channel}/templates?refresh=true`).set(auth(tokens.exec)).expect(200);
    expect(listCalls()).toBe(before + 2);
    expect(JSON.stringify(res.body)).not.toContain(AUTH_TOKEN);
  });

  it('is for staff who reply or manage templates', async () => {
    await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.admin)).expect(200);
    const unknown = await api().get(`/v1/channels/${uuidv7()}/templates`).set(auth(tokens.exec)).expect(404);
    expect(unknown.body.error.code).toBe('channel_not_found');
  });
});

describe('customer-service window (the adapter declares 24 hours)', () => {
  it('shows an open window on the conversation, closing 24 h after the last customer message', async () => {
    const detail = await api().get(`/v1/conversations/${conversationId}`).set(auth(tokens.exec)).expect(200);
    expect(detail.body.sessionWindow).toMatchObject({ open: true, hours: 24 });
    const closes = Date.parse(detail.body.sessionWindow.closesAt) - Date.now();
    expect(closes).toBeGreaterThan(23 * 3_600_000);
    expect(closes).toBeLessThanOrEqual(24 * 3_600_000);
  });

  it('refuses a free-form reply after the window with 409 session_window_closed and stores nothing', async () => {
    await closeWindow();
    const detail = await api().get(`/v1/conversations/${conversationId}`).set(auth(tokens.exec)).expect(200);
    expect(detail.body.sessionWindow.open).toBe(false);
    const res = await api().post(`/v1/conversations/${conversationId}/messages`).set(auth(tokens.exec)).send({ clientMessageId: 'reply-after-window', parts: [{ type: 'TEXT', text: 'Hello?' }] }).expect(409);
    expect(res.body.error).toMatchObject({ category: 'conflict', code: 'session_window_closed', details: { closesAt: expect.any(String) } });
    expect(res.body.error.message).toMatch(/^The 24-hour reply window closed/);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM interactions WHERE idempotency_key = 'human:reply-after-window'`);
    expect(rows[0].n).toBe(0);
  });
});

describe('sending a template', () => {
  it('refuses unapproved templates, missing variables, non-holders and roles without reply rights', async () => {
    expect((await templateMessage(tokens.exec, { templateId: PENDING, variables: { '1': 'Sam', '2': 'Tuesday' } }).expect(400)).body.error.code).toBe('template_not_approved');
    const missing = await templateMessage(tokens.exec, { templateId: APPROVED, variables: { '1': 'Priya' } }).expect(400);
    expect(missing.body.error).toMatchObject({ code: 'template_variables_invalid', details: { problems: [{ key: '2', message: '{{2}} (body) required' }] } });
    expect((await templateMessage(tokens.exec, { ...orderReady, language: 'hi' }).expect(400)).body.error.code).toBe('template_language_mismatch');
    expect((await templateMessage(tokens.exec, { templateId: 'HX00000000000000000000000000000000', variables: {} }).expect(400)).body.error.code).toBe('template_not_found');
    expect((await templateMessage(tokens.exec2, orderReady).expect(400)).body.error.code).toBe('not_handler');
    await templateMessage(tokens.admin, orderReady).expect(403);
    await templateMessage(tokens.otherLead, orderReady).expect(403);
  });

  it('persists the filled text with template metadata, audits it, is idempotent, and delivers through the adapter', async () => {
    const clientMessageId = randomUUID();
    const sent = await templateMessage(tokens.exec, { ...orderReady, clientMessageId }).expect(201);
    expect(sent.body).toMatchObject({ duplicate: false, reopened: false });
    const again = await templateMessage(tokens.exec, { ...orderReady, clientMessageId }).expect(201);
    expect(again.body).toMatchObject({ interactionId: sent.body.interactionId, duplicate: true });

    const timeline = await api().get(`/v1/conversations/${conversationId}/timeline`).set(auth(tokens.exec)).expect(200);
    const message = timeline.body.find((i: { id: string }) => i.id === sent.body.interactionId);
    expect(message).toMatchObject({ kind: 'message', actorType: 'HUMAN', deliveryStatus: 'PENDING' });
    expect(message.parts).toEqual([
      {
        type: 'STRUCTURED',
        schema: 'ocso.message_template',
        fallbackText: 'Hi Priya, your order A-10423 is ready for pickup at the front desk.',
        data: expect.objectContaining({ templateId: APPROVED, name: 'order_ready_pickup', language: 'en', category: 'UTILITY', variables: { '1': 'Priya', '2': 'A-10423' } }),
      },
    ]);
    const audit = await h.db.pool.query(`SELECT summary, after FROM audit_events WHERE action = 'conversation.template_sent' AND target_id = $1`, [conversationId]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].after).toMatchObject({ templateId: APPROVED, variables: ['1', '2'] });

    // Delivery (the worker's channel.deliver job): outside the window, through Content SID + variables.
    const delivery = new DeliveryService(h.db.db, h.app.get(ChannelRuntime), h.app.get<BlobStore>(BLOB_STORE));
    expect(await delivery.deliver(sent.body.interactionId, 'test-delivery')).toEqual({ kind: 'sent' });
    const post = stub.requests.filter((r) => r.path.endsWith('/Messages.json')).at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(post.body))).toMatchObject({ To: 'whatsapp:+919812341208', ContentSid: APPROVED, ContentVariables: '{"1":"Priya","2":"A-10423"}' });
    const { rows } = await h.db.pool.query(`SELECT delivery_status, external_message_id FROM interactions WHERE id = $1`, [sent.body.interactionId]);
    expect(rows[0]).toMatchObject({ delivery_status: 'SENT', external_message_id: expect.stringMatching(/^SM/) });
  });

  it('still delivers template messages stored before the rename (ocso.whatsapp_template parts)', async () => {
    const sent = await templateMessage(tokens.exec, orderReady).expect(201);
    await h.db.pool.query(`UPDATE interaction_parts SET content = jsonb_set(content, '{schema}', '"ocso.whatsapp_template"') WHERE interaction_id = $1`, [sent.body.interactionId]);
    const delivery = new DeliveryService(h.db.db, h.app.get(ChannelRuntime), h.app.get<BlobStore>(BLOB_STORE));
    expect(await delivery.deliver(sent.body.interactionId, 'test-delivery-legacy')).toEqual({ kind: 'sent' });
    const post = stub.requests.filter((r) => r.path.endsWith('/Messages.json')).at(-1)!;
    expect(Object.fromEntries(new URLSearchParams(post.body))).toMatchObject({ ContentSid: APPROVED });
  });

  it('a free-form reply that slipped into the queue before the window closed fails as session_window_closed', async () => {
    await h.db.pool.query(`UPDATE conversations SET last_customer_message_at = now() WHERE id = $1`, [conversationId]);
    const reply = await api().post(`/v1/conversations/${conversationId}/messages`).set(auth(tokens.exec)).send({ clientMessageId: 'reply-in-window', parts: [{ type: 'TEXT', text: 'Checking now' }] }).expect(201);
    await closeWindow();
    const delivery = new DeliveryService(h.db.db, h.app.get(ChannelRuntime), h.app.get<BlobStore>(BLOB_STORE));
    expect(await delivery.deliver(reply.body.interactionId, 'test-delivery')).toEqual({ kind: 'failed', reason: 'session_window_closed' });
  });

  it('reopens a resolved conversation and sends in one step only when asked', async () => {
    await api().post(`/v1/conversations/${conversationId}/resolve`).set(auth(tokens.exec)).send({}).expect(204);
    expect((await templateMessage(tokens.exec, orderReady).expect(400)).body.error.code).toBe('conversation_resolved');
    const sent = await templateMessage(tokens.exec, { ...orderReady, reopen: true }).expect(201);
    expect(sent.body).toMatchObject({ duplicate: false, reopened: true });
    const detail = await api().get(`/v1/conversations/${conversationId}`).set(auth(tokens.exec)).expect(200);
    expect(detail.body).toMatchObject({ controlState: 'HUMAN_ACTIVE', assignedUser: { id: ids.execId } });
  });
});

describe('creating templates (CS Lead) and the review loop', () => {
  const draft = {
    name: 'card_blocked_update',
    language: 'en',
    category: 'UTILITY',
    body: 'Hi {{1}}, your card ending {{2}} is blocked for your safety. Reply here and we will help you.',
    footer: 'Meridian Bank',
    examples: { '1': 'Priya', '2': '4821' },
  };
  let created: { id: string; status: string };

  it('only message_templates.manage holders whose teams use the channel may create; drafts are validated', async () => {
    await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.exec)).send(draft).expect(403);
    await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.otherLead)).send(draft).expect(404);
    const bad = await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.lead)).send({ ...draft, name: 'Card Blocked', body: '{{1}} blocked' }).expect(400);
    expect(bad.body.error.code).toBe('invalid_template');
    expect(bad.body.error.details.problems.map((p: { field: string }) => p.field)).toEqual(expect.arrayContaining(['name', 'body']));
    const channels = await api().get('/v1/message-templates/channels').set(auth(tokens.lead)).expect(200);
    expect(channels.body).toEqual([expect.objectContaining({ id: ids.channel, kindLabel: 'WhatsApp — Twilio', templates: { reviewer: 'WhatsApp', placeholderScope: 'template' } })]);
    expect((await api().get('/v1/message-templates/channels').set(auth(tokens.otherLead)).expect(200)).body).toEqual([]);
    await api().get('/v1/message-templates/channels').set(auth(tokens.exec)).expect(403);
  });

  it('creates the content, submits it for review, records and audits it', async () => {
    const res = await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.lead)).send(draft).expect(201);
    created = res.body.template;
    expect(res.body.template).toMatchObject({ name: 'card_blocked_update', status: 'PENDING', category: 'UTILITY', contentType: 'whatsapp/card', submission: { submittedBy: { name: 'lead' } } });
    expect(res.body.warnings).toEqual([]);
    const submitted = stub.requests.find((r) => r.path.endsWith('/ApprovalRequests/whatsapp'));
    expect(JSON.parse(submitted!.body)).toEqual({ name: 'card_blocked_update', category: 'UTILITY' });
    const actions = await h.db.pool.query(`SELECT action FROM audit_events WHERE target_type = 'message_template' ORDER BY occurred_at`);
    expect(actions.rows.map((r: { action: string }) => r.action)).toEqual(['message_template.create', 'message_template.submit']);
    await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.lead)).send(draft).expect(409);
    const list = await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.exec)).expect(200);
    expect(list.body.templates.find((t: { id: string }) => t.id === created.id)).toMatchObject({ status: 'PENDING' });
    expect((await templateMessage(tokens.exec, { templateId: created.id, variables: { '1': 'Priya', '2': '4821' } }).expect(400)).body.error.code).toBe('template_not_approved');
  });

  it('the poller records the approval, notifies the submitter, and the template becomes sendable', async () => {
    stub.approve(created.id, 'approved');
    const runtime = h.app.get(ChannelRuntime);
    expect(await pollPendingTemplates(h.db.db, templateProviderSource(runtime), { correlationId: 'test-poll' })).toEqual({ checked: 1, changed: 1, failed: 0 });
    const events = await h.db.pool.query(`SELECT payload FROM outbox_events WHERE type = 'message_template.status_changed'`);
    expect(events.rows.map((r: { payload: unknown }) => r.payload)).toEqual([expect.objectContaining({ templateId: created.id, status: 'APPROVED', previousStatus: 'PENDING', submittedBy: expect.any(String) })]);
    const status = await api().get(`/v1/channels/${ids.channel}/templates/${created.id}`).set(auth(tokens.lead)).expect(200);
    expect(status.body).toMatchObject({ status: 'APPROVED', rejectionReason: null });
    // The API's cached list is older than the poller's check: the recorded status wins.
    const list = await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.exec)).expect(200);
    expect(list.body.templates.find((t: { id: string }) => t.id === created.id)).toMatchObject({ status: 'APPROVED' });
    const sent = await templateMessage(tokens.exec, { templateId: created.id, variables: { '1': 'Priya', '2': '4821' } }).expect(201);
    const timeline = await api().get(`/v1/conversations/${conversationId}/timeline`).set(auth(tokens.exec)).expect(200);
    expect(timeline.body.find((i: { id: string }) => i.id === sent.body.interactionId).parts[0].fallbackText).toBe(
      'Hi Priya, your card ending 4821 is blocked for your safety. Reply here and we will help you.\n\nMeridian Bank',
    );
  });

  it('a rejection carries the reason; delete removes it at the provider and from the list', async () => {
    const other = await api().post(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.admin)).send({ ...draft, name: 'card_blocked_v2' }).expect(201);
    stub.approve(other.body.template.id, 'rejected', 'INVALID_FORMAT');
    await pollPendingTemplates(h.db.db, templateProviderSource(h.app.get(ChannelRuntime)), { correlationId: 'test-poll-2' });
    const status = await api().get(`/v1/channels/${ids.channel}/templates/${other.body.template.id}`).set(auth(tokens.lead)).expect(200);
    expect(status.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' });
    await api().delete(`/v1/channels/${ids.channel}/templates/${other.body.template.id}`).set(auth(tokens.exec)).expect(403);
    await api().delete(`/v1/channels/${ids.channel}/templates/${other.body.template.id}`).set(auth(tokens.lead)).expect(204);
    expect(stub.contents.has(other.body.template.id)).toBe(false);
    const list = await api().get(`/v1/channels/${ids.channel}/templates`).set(auth(tokens.lead)).expect(200);
    expect(list.body.templates.map((t: { id: string }) => t.id)).not.toContain(other.body.template.id);
    const { rows } = await h.db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'message_template.delete'`);
    expect(rows[0].n).toBe(1);
  });
});
