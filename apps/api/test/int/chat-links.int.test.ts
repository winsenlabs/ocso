import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LINK_CODE_ATTEMPTS, RecoveryService, applyAuthPolicy, issueLinkToken, loadPrincipal, systemActor } from '@ocso/application';
import { deploymentSettings, modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { DelegationTokens } from '../../src/common/delegation.js';
import { LoopbackCapabilityRunner } from '../../src/modules/internal-agent/loopback-runner.js';
import { STAFF_MESSAGES_PER_MINUTE, StaffChatService } from '../../src/modules/internal-agent/staff-chat.service.js';
import { ADMIN, addUserWithPassword, completeSetup, startApi, type ApiHarness } from './harness.js';
import { liveChannel } from './platform.js';

/**
 * Ask OCSO over a staff Slack channel (destination `ask_ocso`) on the real API, with a fake Slack Web API: an unknown
 * sender gets a one-time link (privately, nothing becomes a customer conversation); the `/link/<token>` page's
 * preview and confirm, which only claims the link and shows a code that must come back from the same chat account
 * (audited; "Linked." in the chat; used, expired, wrong and already-linked tokens refused; an OCSO user cannot be
 * talked into linking someone else's chat account); a
 * linked message runs Ask OCSO as the user (a read, in a thread the drawer lists); a direct write card confirmed by
 * button from the same chat identity and refused from another; a governed card links into OCSO; the rate limit;
 * the link-bound delegation refused off the loopback listener and after revoke; revoke and user disable stop it.
 */

const SIGNING_SECRET = 'b1c2d3e4f5a60718293a4b5c6d7e8f90';
const BOT_TOKEN = 'xoxb-fake-test-token-01';
const TEAM = 'T0MERIDIAN';
const BOT = 'U0OCSOBOT1';
const HEAD_USER = 'U0HEADUSR1';
const ADMIN_USER = 'U0ADMINUS1';
const STRANGER = 'U0STRANGR1';
const SERVICE_USER = 'U0SERVICE1';
const DM: Record<string, string> = { [HEAD_USER]: 'D0HEADDM01', [ADMIN_USER]: 'D0ADMNDM01', [STRANGER]: 'D0STRNDM01', [SERVICE_USER]: 'D0SERVDM01' };
const PASSWORD = 'staff chat password 1234';

let h: ApiHarness;
let admin: string;
let head: string;
let service: string;
const ids = { admin: '', head: '', service: '', team: '' };
let stub: Server;
const slackCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let channel: { id: string; publicKey: string; webhookPath: string };
let posts = 0;
let events = 0;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

const now = () => String(Math.floor(Date.now() / 1000));
const sign = (body: string, ts = now()) => `v0=${createHmac('sha256', SIGNING_SECRET).update(`v0:${ts}:${body}`).digest('hex')}`;
function post(body: string, form = false) {
  const ts = now();
  return h
    .http()
    .post(channel.webhookPath)
    .set('content-type', form ? 'application/x-www-form-urlencoded' : 'application/json')
    .set('x-slack-request-timestamp', ts)
    .set('x-slack-signature', sign(body, ts))
    .send(body);
}

/** A DM from a Slack user to the app; answered in the background, so wait for it. */
async function dm(user: string, text: string, eventId = `Ev0STAFF${String(++events).padStart(4, '0')}`): Promise<void> {
  const body = JSON.stringify({
    type: 'event_callback',
    team_id: TEAM,
    api_app_id: 'A0OCSO',
    event_id: eventId,
    event_time: 1790244000,
    authorizations: [{ team_id: TEAM, user_id: BOT, is_bot: true }],
    event: { type: 'message', channel_type: 'im', channel: DM[user], user, team: TEAM, text, ts: `1790244${String(events).padStart(3, '0')}.000100` },
  });
  await post(body).expect(200);
  await h.app.get(StaffChatService).idle();
}

/** A button tap on a message the app posted, as `user`, with the block id Slack echoes back. */
async function tap(user: string, blockId: string, actionId: string, value: string): Promise<void> {
  const payload = {
    type: 'block_actions',
    team: { id: TEAM },
    user: { id: user, team_id: TEAM, username: user.toLowerCase() },
    container: { type: 'message', channel_id: DM[user], message_ts: `1790245000.${String(posts).padStart(6, '0')}` },
    message: { ts: `1790245000.${String(posts).padStart(6, '0')}` },
    actions: [{ type: 'button', block_id: blockId, action_id: actionId, value, text: { type: 'plain_text', text: 'Confirm' }, action_ts: `179024501${events}.000001` }],
  };
  events++;
  await post(new URLSearchParams({ payload: JSON.stringify(payload) }).toString(), true).expect(200);
  await h.app.get(StaffChatService).idle();
}

const lastPost = () => slackCalls.filter((c) => c.method === 'chat.postMessage').at(-1)!.body;
const postsSince = (n: number) => slackCalls.filter((c) => c.method === 'chat.postMessage').slice(n).map((c) => c.body);
const postCount = () => slackCalls.filter((c) => c.method === 'chat.postMessage').length;
const tokenIn = (text: unknown) => /\/link\/([A-Za-z0-9_-]{43})/.exec(String(text))?.[1] ?? null;
const directive = (name: string, args: Record<string, unknown>) => `[[call:execute_tool ${JSON.stringify({ name, args })}]]`;

/** Link `user`'s Slack account from its last link message: confirm on the page as `token`'s user, then send the code from Slack. */
async function linkAs(user: string, token: string): Promise<string> {
  const before = postCount();
  const res = await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(token)).send({ token: tokenIn(lastPost()['text'])! }).expect(200);
  // "Almost linked" reaches the chat in the background.
  await expect.poll(() => postCount()).toBe(before + 1);
  await dm(user, res.body.code as string);
  expect(lastPost()['text']).toBe('Linked. Ask me anything.');
  const { rows } = await h.db.pool.query(`SELECT id FROM channel_account_links WHERE identity_value = $1 AND revoked_at IS NULL`, [`${TEAM}:${user}`]);
  return rows[0].id as string;
}

beforeAll(async () => {
  stub = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const method = (req.url ?? '').replace(/^\/api\//, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      slackCalls.push({ method, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.headers.authorization !== `Bearer ${BOT_TOKEN}`) return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
      if (method === 'chat.postMessage') {
        posts += 1;
        return res.end(JSON.stringify({ ok: true, channel: body['channel'], ts: `1790245000.${String(posts).padStart(6, '0')}` }));
      }
      return res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api`;

  h = await startApi({ env: { OCSO_ENABLE_DEV_PROVIDERS: 'true' } });
  admin = await completeSetup(h);
  ids.admin = (await h.db.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ADMIN.email])).rows[0]!.id;
  await h.http().patch('/v1/settings/deployment').set(auth(admin)).send({ egressAllowedInternalHosts: ['127.0.0.1'], approval: { bootstrap: true, reason: 'Sole Tech: local Slack stub' } }).expect(202);
  ids.head = await addUserWithPassword(h, { email: 'head@staff.test', name: 'Hana Head', role: 'HEAD', password: PASSWORD });
  head = await h.loginAs('head@staff.test', PASSWORD);
  ids.service = await addUserWithPassword(h, { email: 'service@staff.test', name: 'Sol Service', role: 'SERVICE', password: PASSWORD });
  service = await h.loginAs('service@staff.test', PASSWORD);
  ids.team = (await h.http().post('/v1/teams').set(auth(head)).send({ name: 'Cards' }).expect(201)).body.id;

  // Ask OCSO runs on the development scripted model: `[[call:execute_tool {…}]]` calls exactly that capability.
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted', settings: { latencyMs: 0, chunkDelayMs: 0 } });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'ask-ocso', providerId: provider, model: 'scripted', retries: 0 });
  await h.db.db.update(deploymentSettings).set({ internalAgentProfileId: profile }).where(eq(deploymentSettings.id, 1));

  channel = await liveChannel<{ id: string; publicKey: string; webhookPath: string }>(h, admin, { id: ids.head, token: head }, {
    kind: 'SLACK',
    name: 'Ask OCSO Slack',
    settings: { destination: 'ask_ocso', respondTo: 'dm', apiBaseUrl: stubUrl },
    secrets: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET },
  });
});

afterAll(async () => {
  await h?.close();
  await new Promise((resolve) => stub?.close(resolve));
});

describe('the destination setting', () => {
  it('is offered on Slack (a staff-destination kind) and validated', async () => {
    const kinds = await h.http().get('/v1/channels/kinds').set(auth(admin)).expect(200);
    const slack = kinds.body.find((k: { kind: string }) => k.kind === 'SLACK');
    expect(slack.staffDestination).toBe(true);
    expect(slack.settingsSchema.properties.destination).toMatchObject({ enum: ['router', 'ask_ocso'], default: 'router' });
    const whatsapp = kinds.body.find((k: { kind: string }) => k.kind === 'WHATSAPP');
    expect(whatsapp.settingsSchema.properties.destination).toBeUndefined();
    const res = await h.http().post('/v1/channels').set(auth(admin)).send({ kind: 'SLACK', name: 'Bad', settings: { destination: 'nowhere' }, secrets: { botToken: BOT_TOKEN, signingSecret: SIGNING_SECRET } }).expect(400);
    expect(JSON.stringify(res.body)).toContain('settings.destination');
  });
});

describe('linking a chat account', () => {
  it('an unknown sender gets a one-time link, privately, and nothing becomes a customer conversation', async () => {
    const before = postCount();
    await dm(HEAD_USER, 'What needs me today?', 'Ev0FIRST001');
    const sent = postsSince(before);
    expect(sent).toHaveLength(1);
    // Sent to the user directly (no reply context: Slack opens the DM), never into a shared thread.
    expect(sent[0]).toMatchObject({ channel: HEAD_USER });
    expect(String(sent[0]!['text'])).toMatch(/^Link your account: <http:\/\/localhost:3000\/link\/[A-Za-z0-9_-]{43}>/);
    // Slack retries carry the same event id: taken once.
    await dm(HEAD_USER, 'What needs me today?', 'Ev0FIRST001');
    expect(postCount()).toBe(before + 1);
    const { rows } = await h.db.pool.query(`SELECT (SELECT count(*)::int FROM interactions WHERE channel_id = $1) AS i, (SELECT count(*)::int FROM customers) AS c, (SELECT count(*)::int FROM channel_link_tokens) AS t`, [channel.id]);
    expect(rows[0]).toEqual({ i: 0, c: 0, t: 1 });
    const stored = await h.db.pool.query(`SELECT token_hash FROM channel_link_tokens`);
    expect(stored.rows[0].token_hash).not.toBe(tokenIn(sent[0]!['text']));
  });

  it('the link page previews and claims; the code from the same chat account links it; used, wrong and expired links are refused', async () => {
    const token = tokenIn(lastPost()['text'])!;
    const preview = await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(head)).send({ token }).expect(200);
    expect(preview.body).toMatchObject({ state: 'valid', network: 'Slack', identity: `slack · ${HEAD_USER}`, account: `${TEAM}:${HEAD_USER}`, channel: { id: channel.id, name: 'Ask OCSO Slack' }, refusal: null, alreadyLinked: false, you: { name: 'Hana Head', email: 'head@staff.test' } });

    let before = postCount();
    const claimed = await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(head)).send({ token }).expect(200);
    expect(claimed.body).toMatchObject({ link: null, existing: false, code: expect.stringMatching(/^\d{6}$/) });
    const code = claimed.body.code as string;
    // The chat hears to send the code (where it asked for the link), never the code itself.
    await expect.poll(() => postCount()).toBe(before + 1);
    expect(lastPost()).toMatchObject({ channel: DM[HEAD_USER] });
    expect(String(lastPost()['text'])).toMatch(/^Almost linked: send me the 6-digit code/);
    expect(JSON.stringify(slackCalls)).not.toContain(code);
    // Nothing is linked yet, and the page can still be used (it is only claimed).
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links`)).rows[0].n).toBe(0);
    expect((await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(head)).send({ token }).expect(200)).body.state).toBe('valid');

    // Other text asks for the code; a wrong code counts down.
    await dm(HEAD_USER, 'What needs me today?');
    expect(String(lastPost()['text'])).toMatch(/^To finish linking, send me the 6-digit code/);
    const wrong = code === '000000' ? '111111' : '000000';
    await dm(HEAD_USER, wrong);
    expect(lastPost()['text']).toBe(`That is not the code the OCSO page shows. ${LINK_CODE_ATTEMPTS - 1} tries left.`);

    before = postCount();
    await dm(HEAD_USER, `${code.slice(0, 3)} ${code.slice(3)}`);
    expect(postsSince(before)).toEqual([expect.objectContaining({ channel: DM[HEAD_USER], text: 'Linked. Ask me anything.' })]);
    const audit = await h.db.pool.query(`SELECT actor_id, via, target_type FROM audit_events WHERE action = 'channel.account_link'`);
    expect(audit.rows).toEqual([{ actor_id: ids.head, via: 'UI', target_type: 'channel_account_link' }]);
    expect((await h.db.pool.query(`SELECT user_id, auth_method FROM channel_account_links WHERE revoked_at IS NULL`)).rows).toEqual([{ user_id: ids.head, auth_method: 'password' }]);

    const used = await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(head)).send({ token }).expect(409);
    expect(used.body.error.code).toBe('link_token_used');
    expect((await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(head)).send({ token }).expect(200)).body.state).toBe('used');
    await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(head)).send({ token: 'A'.repeat(43) }).expect(404);
    await h.http().post('/v1/internal-agent/link-tokens/confirm').send({ token }).expect(401);

    await dm(STRANGER, 'hello');
    const stale = tokenIn(lastPost()['text'])!;
    await h.db.pool.query(`UPDATE channel_link_tokens SET expires_at = now() - interval '1 second' WHERE identity_value LIKE $1`, [`%${STRANGER}`]);
    expect((await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(service)).send({ token: stale }).expect(200)).body.state).toBe('expired');
    expect((await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(service)).send({ token: stale }).expect(400)).body.error.code).toBe('link_token_expired');
  });

  it('an OCSO user cannot be talked into linking someone else’s chat account: the code must come from that account', async () => {
    // Mallory (STRANGER) gets a link and sends it to the Tech admin, who confirms it.
    await h.db.pool.query(`UPDATE channel_link_tokens SET created_at = created_at - interval '1 hour' WHERE identity_value LIKE $1`, [`%${STRANGER}`]);
    await dm(STRANGER, 'please link me');
    const token = tokenIn(lastPost()['text'])!;
    const claimed = await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(admin)).send({ token }).expect(200);
    const code = claimed.body.code as string;
    await expect.poll(() => String(lastPost()['text'])).toMatch(/^Almost linked/);

    // The code sent from another chat account (the admin's own) links nothing: that account just gets its own link.
    await dm(ADMIN_USER, code);
    expect(tokenIn(lastPost()['text'])).not.toBeNull();
    // Mallory, without the code, guesses: every wrong code counts, and the claim is burned after the last try.
    const guesses = ['000000', '111111', '222222', '333333', '444444', '555555'].filter((g) => g !== code).slice(0, LINK_CODE_ATTEMPTS);
    for (const guess of guesses) await dm(STRANGER, guess);
    expect(lastPost()['text']).toBe('That is not the code, and there are no tries left. Send me a new message to get a fresh link.');
    await dm(STRANGER, code);
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links WHERE identity_value LIKE $1`, [`%${STRANGER}`])).rows[0].n).toBe(0);
    expect((await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(admin)).send({ token }).expect(200)).body.state).toBe('used');
    await h.db.pool.query(`UPDATE channel_link_tokens SET created_at = created_at - interval '1 hour'`);
  });

  it('a chat account linked to someone else cannot be linked again', async () => {
    const other = (await issueLinkToken(h.db.db, { channelId: channel.id, identityKind: 'slack_user', identityValue: `${TEAM}:${HEAD_USER}` }))!;
    const preview = await h.http().post('/v1/internal-agent/link-tokens/preview').set(auth(service)).send({ token: other }).expect(200);
    expect(preview.body.refusal).toMatch(/already linked to another OCSO user/);
    expect((await h.http().post('/v1/internal-agent/link-tokens/confirm').set(auth(service)).send({ token: other }).expect(409)).body.error.code).toBe('chat_identity_linked');
    const { rows } = await h.db.pool.query(`SELECT user_id FROM channel_account_links WHERE revoked_at IS NULL AND identity_value = $1`, [`${TEAM}:${HEAD_USER}`]);
    expect(rows).toEqual([{ user_id: ids.head }]);
  });
});

describe('Ask OCSO from chat', () => {
  it('a linked message runs Ask OCSO as the user (a read), in a thread the drawer lists', async () => {
    const before = postCount();
    await dm(HEAD_USER, directive('users.list_teams', {}));
    const sent = postsSince(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: DM[HEAD_USER] });
    expect(String(sent[0]!['text'])).toMatch(/Here's what I found/);
    expect(tokenIn(sent[0]!['text'])).toBeNull();

    const threads = await h.http().get('/v1/internal-agent/threads').set(auth(head)).expect(200);
    const chatThread = threads.body.find((t: { surface: string | null }) => t.surface === 'slack');
    expect(chatThread).toMatchObject({ userId: ids.head, surface: 'slack' });
    const { rows } = await h.db.pool.query(`SELECT last_used_at FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.head]);
    expect(rows[0].last_used_at).not.toBeNull();
    // The same DM continues the same thread.
    await dm(HEAD_USER, directive('users.list_teams', {}));
    const again = await h.http().get('/v1/internal-agent/threads').set(auth(head)).expect(200);
    expect(again.body.filter((t: { surface: string | null }) => t.surface === 'slack')).toHaveLength(1);
  });

  it('a direct write card is confirmed by its button from the same chat identity only, and audited with the surface', async () => {
    // The Tech admin links their own Slack account too.
    await dm(ADMIN_USER, 'hi');
    await linkAs(ADMIN_USER, admin);

    const before = postCount();
    await dm(HEAD_USER, directive('users.update_team', { id: ids.team, name: 'Cards Desk' }));
    const sent = postsSince(before).at(-1)!;
    const blocks = sent['blocks'] as Array<{ type: string; block_id?: string; elements?: Array<{ action_id: string; value: string }> }>;
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.block_id).toBe(`ocso.choices:${HEAD_USER}`);
    const [confirm, cancel] = actions.elements!;
    expect(confirm!.value).toMatch(/^ocso-card:[0-9a-f-]{36}:confirm$/);
    expect(cancel!.value).toMatch(/:cancel$/);
    const cardId = confirm!.value.split(':')[1]!;

    // Another linked chat identity (even one whose user could make the change) is refused.
    await tap(ADMIN_USER, `ocso.choices:${ADMIN_USER}`, confirm!.action_id, confirm!.value);
    expect(lastPost()).toMatchObject({ channel: DM[ADMIN_USER], text: 'This button is not yours: only the person who asked can confirm or cancel it.' });
    expect((await h.db.pool.query(`SELECT status FROM internal_agent_actions WHERE id = $1`, [cardId])).rows[0].status).toBe('PENDING');

    await tap(HEAD_USER, `ocso.choices:${HEAD_USER}`, confirm!.action_id, confirm!.value);
    expect(lastPost()).toMatchObject({ channel: DM[HEAD_USER] });
    expect(String(lastPost()['text'])).toMatch(/^Done: Update team · Cards\.\n<http:\/\/localhost:3000\/team\|Open in OCSO>$/);
    expect((await h.db.pool.query(`SELECT status FROM internal_agent_actions WHERE id = $1`, [cardId])).rows[0].status).toBe('EXECUTED');
    expect((await h.db.pool.query(`SELECT name FROM teams WHERE id = $1`, [ids.team])).rows[0].name).toBe('Cards Desk');
    // The route's own audit row and the card's: the human, via INTERNAL_AGENT, with the surface and the link.
    const audit = await h.db.pool.query(`SELECT action, actor_id, via, confirmation FROM audit_events WHERE confirmation->'internalAgent'->>'cardId' = $1 ORDER BY occurred_at`, [cardId]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of audit.rows) expect(row).toMatchObject({ actor_id: ids.head, via: 'INTERNAL_AGENT', confirmation: { internalAgent: { surface: 'slack', linkId: expect.any(String) } } });

    // A second tap on a decided card only reports how it ended.
    await tap(HEAD_USER, `ocso.choices:${HEAD_USER}`, cancel!.action_id, cancel!.value);
    expect((await h.db.pool.query(`SELECT status FROM internal_agent_actions WHERE id = $1`, [cardId])).rows[0].status).toBe('EXECUTED');
  });

  it('a governed card links into OCSO instead of offering buttons', async () => {
    await dm(ADMIN_USER, directive('settings.update_deployment_settings', { regionLabel: 'Chennai' }));
    const sent = lastPost();
    expect(sent['blocks']).toBeUndefined();
    expect(String(sent['text'])).toMatch(/needs a checker and a reason/);
    expect(String(sent['text'])).toMatch(/<http:\/\/localhost:3000\/\?askOcso=[0-9a-f-]{36}\|Open in OCSO>/);
  });

  it('rate-limits a chat account', async () => {
    // Real webhook messages (each answered by Ask OCSO) up to the limit in one minute; the next one hears the notice once.
    await h.db.pool.query(`UPDATE channel_staff_messages SET received_at = received_at - interval '2 minutes'`);
    for (let i = 0; i < STAFF_MESSAGES_PER_MINUTE; i++) await dm(ADMIN_USER, `burst ${i}`);
    const before = postCount();
    await dm(ADMIN_USER, 'one more');
    expect(postsSince(before)).toHaveLength(1);
    expect(String(lastPost()['text'])).toMatch(/faster than Ask OCSO answers/);
    await dm(ADMIN_USER, 'and another');
    expect(postCount()).toBe(before + 1);
    await h.db.pool.query(`UPDATE channel_staff_messages SET received_at = received_at - interval '2 minutes'`);
  });
});

describe('revoking and disabling', () => {
  it('the link-bound delegation works only on the loopback listener and only while the link is active', async () => {
    const [link] = (await h.db.pool.query(`SELECT id FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.head])).rows;
    const tokens = h.app.get(DelegationTokens);
    const runner = h.app.get(LoopbackCapabilityRunner);
    const threadId = (await h.db.pool.query(`SELECT id FROM internal_agent_threads WHERE channel_link_id = $1`, [link.id])).rows[0].id;
    const principal = { ...(await loadPrincipal(h.db.db, ids.head, 'INTERNAL_AGENT'))!, chatLink: { linkId: link.id, surface: 'slack' } };

    // Off the private listener (the public app), a valid link-bound token is refused.
    const token = tokens.issue({ userId: ids.head, linkId: link.id, surface: 'slack', threadId, method: 'GET', path: '/v1/teams' });
    await h.http().get('/v1/teams').set('authorization', `Delegation ${token}`).expect(401);
    expect((await runner.call(principal, { threadId, callId: 'c1', correlationId: 'c1' }, { method: 'GET', path: '/v1/teams' })).status).toBe(200);
    // A token bound to neither a session nor a link is never issued.
    expect(() => tokens.issue({ userId: ids.head, threadId, method: 'GET', path: '/v1/teams' })).toThrow(/session or to a chat link/);

    // Someone else's link cannot be revoked without users.manage (not even acknowledged).
    await h.http().post(`/v1/internal-agent/chat-links/${link.id}/revoke`).set(auth(service)).expect(404);
    const mine = await h.http().get('/v1/internal-agent/chat-links').set(auth(head)).expect(200);
    expect(mine.body.map((l: { id: string }) => l.id)).toEqual([link.id]);
    await h.http().post(`/v1/internal-agent/chat-links/${link.id}/revoke`).set(auth(head)).expect(200);
    expect((await h.http().get('/v1/internal-agent/chat-links').set(auth(head)).expect(200)).body).toEqual([]);
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'channel.account_unlink' AND target_id = $1`, [link.id])).rows[0].n).toBe(1);

    expect((await runner.call(principal, { threadId, callId: 'c2', correlationId: 'c2' }, { method: 'GET', path: '/v1/teams' })).status).toBe(401);
    // The chat account is unknown again: its next message gets a fresh link.
    await h.db.pool.query(`UPDATE channel_link_tokens SET created_at = created_at - interval '1 hour'`);
    await dm(HEAD_USER, 'still there?');
    expect(tokenIn(lastPost()['text'])).not.toBeNull();
  });

  it('a Tech admin sees and revokes a user’s links; others cannot list them', async () => {
    await linkAs(HEAD_USER, head);
    const listed = await h.http().get(`/v1/internal-agent/users/${ids.head}/chat-links`).set(auth(admin)).expect(200);
    expect(listed.body).toHaveLength(1);
    await h.http().get(`/v1/internal-agent/users/${ids.head}/chat-links`).set(auth(service)).expect(403);
    await h.http().post(`/v1/internal-agent/chat-links/${listed.body[0].id}/revoke`).set(auth(admin)).expect(200);
    expect((await h.http().get(`/v1/internal-agent/users/${ids.head}/chat-links`).set(auth(admin)).expect(200)).body).toEqual([]);
  });

  it('a linked user who loses internal_agent.use hears "access removed", and the link-bound delegation is refused', async () => {
    await dm(SERVICE_USER, 'hi');
    const linkId = await linkAs(SERVICE_USER, service);
    await dm(SERVICE_USER, directive('users.list_teams', {}));
    const threadId = (await h.db.pool.query(`SELECT id FROM internal_agent_threads WHERE channel_link_id = $1`, [linkId])).rows[0].id as string;
    const principal = { ...(await loadPrincipal(h.db.db, ids.service, 'INTERNAL_AGENT'))!, chatLink: { linkId, surface: 'slack' } };
    const runner = h.app.get(LoopbackCapabilityRunner);
    expect((await runner.call(principal, { threadId, callId: 'r1', correlationId: 'r1' }, { method: 'GET', path: '/v1/teams' })).status).toBe(200);

    // An override takes Ask OCSO away (the link stays; rights are read fresh on every message and every call).
    await h.db.pool.query(`INSERT INTO user_permission_grants (id, user_id, permission, effect, reason) VALUES ($1, $2, 'internal_agent.use', 'REVOKE', 'test')`, [uuidv7(), ids.service]);
    const before = postCount();
    await dm(SERVICE_USER, directive('users.list_teams', {}));
    expect(postsSince(before)).toHaveLength(1);
    expect(String(lastPost()['text'])).toMatch(/^Your OCSO access to Ask OCSO was removed \(Your OCSO role does not include Ask OCSO/);
    expect((await runner.call(principal, { threadId, callId: 'r2', correlationId: 'r2' }, { method: 'GET', path: '/v1/teams' })).status).toBe(401);

    await h.db.pool.query(`UPDATE user_permission_grants SET cleared_at = now() WHERE user_id = $1`, [ids.service]);
    expect((await runner.call(principal, { threadId, callId: 'r3', correlationId: 'r3' }, { method: 'GET', path: '/v1/teams' })).status).toBe(200);
  });

  it('when the MFA policy tightens after linking, the chat is offered a fresh link and the delegation is refused', async () => {
    const [link] = (await h.db.pool.query(`SELECT id FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.service])).rows;
    const threadId = (await h.db.pool.query(`SELECT id FROM internal_agent_threads WHERE channel_link_id = $1`, [link.id])).rows[0].id as string;
    const principal = { ...(await loadPrincipal(h.db.db, ids.service, 'INTERNAL_AGENT'))!, chatLink: { linkId: link.id, surface: 'slack' } };
    const runner = h.app.get(LoopbackCapabilityRunner);
    await applyAuthPolicy(h.db.db, systemActor('test', 'mfa-tighten'), { requireMfaRoles: ['SERVICE'] });
    try {
      const before = postCount();
      await dm(SERVICE_USER, directive('users.list_teams', {}));
      const sent = postsSince(before);
      expect(sent).toHaveLength(1);
      expect(String(sent[0]!['text'])).toMatch(/^Your organization now requires two-factor authentication/);
      expect(tokenIn(sent[0]!['text'])).not.toBeNull();
      expect(String(sent[0]!['text'])).not.toMatch(/Here's what I found/);
      expect((await runner.call(principal, { threadId, callId: 'm1', correlationId: 'm1' }, { method: 'GET', path: '/v1/teams' })).status).toBe(401);
      // The link itself stays (linking again after signing in with MFA refreshes it).
      expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links WHERE id = $1 AND revoked_at IS NULL`, [link.id])).rows[0].n).toBe(1);
    } finally {
      await applyAuthPolicy(h.db.db, systemActor('test', 'mfa-relax'), { requireMfaRoles: [] });
    }
    expect((await runner.call(principal, { threadId, callId: 'm2', correlationId: 'm2' }, { method: 'GET', path: '/v1/teams' })).status).toBe(200);
  });

  it('disabling a user revokes their links and stops the chat', async () => {
    await h.db.pool.query(`UPDATE channel_link_tokens SET created_at = created_at - interval '1 hour'`);
    await dm(HEAD_USER, 'relink me');
    await linkAs(HEAD_USER, head);
    await h.http().patch(`/v1/users/${ids.head}`).set(auth(admin)).send({ status: 'DISABLED' }).expect(200);
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.head])).rows[0].n).toBe(0);
    const audit = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'user.disable' AND target_id = $1`, [ids.head]);
    expect(audit.rows[0].summary).toMatch(/revoked 1 chat account link/);
    const before = postCount();
    await h.db.pool.query(`UPDATE channel_link_tokens SET created_at = created_at - interval '1 hour'`);
    await dm(HEAD_USER, directive('users.list_teams', {}));
    const sent = postsSince(before);
    expect(sent).toHaveLength(1);
    expect(tokenIn(sent[0]!['text'])).not.toBeNull();
    expect(String(sent[0]!['text'])).not.toMatch(/Here's what I found/);
  });

  it('break-glass recovery of a Tech admin revokes their chat links', async () => {
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.admin])).rows[0].n).toBe(1);
    const token = 'r'.repeat(40);
    await new RecoveryService(h.db.db, token).recover({ recoveryToken: token, email: ADMIN.email, newPassword: 'a brand new password 42' }, { correlationId: 'recovery' });
    expect((await h.db.pool.query(`SELECT count(*)::int AS n FROM channel_account_links WHERE user_id = $1 AND revoked_at IS NULL`, [ids.admin])).rows[0].n).toBe(0);
    const audit = await h.db.pool.query(`SELECT summary FROM audit_events WHERE action = 'auth.recovery'`);
    expect(audit.rows[0].summary).toMatch(/revoked 1 chat account link/);
  });
});
