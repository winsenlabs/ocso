import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ChannelRuntime, HeldUserTokenSource, loadAgentToolCatalog, ToolRunner, createToolProviderRegistry } from '@ocso/agent-runtime';
import { CustomerClaimsIssuer, McpConnectionService, SettingsService, heldUserTokenFor, recordInstalledApproval, type ActorContext } from '@ocso/application';
import { McpToolProviderFactory, MCP_TOOL_SOURCE } from '@ocso/bootstrap';
import { issueVisitorToken, webChatEmbed, type ChannelRegistry } from '@ocso/channels';
import { agentToolGrants, auditEvents, conversations, customerIdentities, modelProfiles, modelProviders, users, uuidv7, webchatUserTokens } from '@ocso/db';
import type { SecretStore } from '@ocso/secrets';
import { connectionToolSource, createAjvValidator } from '@ocso/tools';
import { CHANNEL_REGISTRY, SECRET_STORE } from '../../src/infrastructure/tokens.js';
import { approveInDb, approveProposal, liveChannel, type Checker } from './platform.js';
import { completeSetup, startApi, ADMIN, type ApiHarness } from './harness.js';
import { routeChannel } from './routing.js';
import { setTeams } from './teams.js';

/** SPEC §C: web chat auth modes, session passes, CORS, native apps, rate limits, context and tool identity. */

const OCSO = 'http://localhost:3000';
const SHOP = 'https://shop.example.test';
const HS = 'host-identity-secret-0123456789-abcdefghij';
const JWKS_URL = 'https://id.example.test/.well-known/jwks.json';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const unix = (offset = 0) => Math.floor(Date.now() / 1000) + offset;
const hs256 = (claims: Record<string, unknown>) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ exp: unix(900), ...claims });
  return `${head}.${body}.${createHmac('sha256', HS).update(`${head}.${body}`).digest('base64url')}`;
};

let h: ApiHarness;
let admin: string;
let checker: Checker;
let agentId: string;
let queueId: string;
let jwksServer: http.Server;
let signIdToken: (claims: Record<string, unknown>) => Promise<string>;

interface Created {
  id: string;
  publicKey: string;
  revealedSecrets?: Record<string, string>;
}

/** A live, routed web chat channel with the given settings; returns its keys (the secret key only from the create response). */
async function channel(settings: Record<string, unknown>, secrets: Record<string, string> = {}): Promise<{ id: string; key: string; secretKey: string }> {
  const created = await liveChannel<Created>(h, admin, checker, { kind: 'WEBCHAT', name: `Chat ${randomBytes(3).toString('hex')}`, settings: { allowedOrigins: [SHOP], ...settings }, secrets });
  await routeChannel(h, created.id, agentId, queueId);
  return { id: created.id, key: created.publicKey, secretKey: created.revealedSecrets!['secretKey']! };
}

const mint = (key: string, secretKey: string, body: Record<string, unknown> = {}) => h.http().post(`/public/webchat/${key}/session-pass`).set(auth(secretKey)).send(body);
const session = (key: string, body: Record<string, unknown>, origin: string | null = SHOP) => {
  const req = h.http().post(`/public/webchat/${key}/session`);
  return (origin ? req.set('origin', origin) : req).send(body);
};
const send = (key: string, token: string, text: string, origin: string | null = SHOP) => {
  const req = h.http().post(`/public/webchat/${key}/messages`).set(auth(token));
  return (origin ? req.set('origin', origin) : req).send({ clientMessageId: `cm_${randomBytes(8).toString('hex')}`, text });
};

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const leadId = (await h.http().post('/v1/users').set(auth(admin)).send({ email: 'lead@ocso.test', name: 'Lena Lead', role: 'HEAD', password: 'a password 12345' }).expect(201)).body.id;
  const lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  checker = { id: leadId, token: lead };
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Web' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [team]);
  queueId = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Web tier 1', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'auth-primary', providerId: provider, model: 'scripted', retries: 0 });
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: profile, title: 'auth-primary' }, 'Test fixture: existing profile');
  agentId = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queueId, teamIds: [team] }).expect(201)).body.id;
  await h.http().post(`/v1/agents/${agentId}/status`).set(auth(lead)).send({ status: 'LIVE', approval: { bootstrap: true, reason: 'Sole Head' } }).expect(202);

  // A local JWKS server standing in for the site's identity provider; the adapter's egress fetch is pointed at it.
  const pair = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'idp-1', alg: 'ES256', use: 'sig' };
  jwksServer = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] })));
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  const port = (jwksServer.address() as { port: number }).port;
  const adapter = h.app.get<ChannelRegistry>(CHANNEL_REGISTRY).get('WEBCHAT') as unknown as { embed: unknown };
  adapter.embed = webChatEmbed({ now: () => new Date(), fetch: (input, init) => fetch(String(input).replace('https://id.example.test', `http://127.0.0.1:${port}`), init) });
  signIdToken = (claims) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'idp-1' }).setIssuer('https://id.example.test').setAudience('ocso-chat').setIssuedAt().setExpirationTime('10m').sign(pair.privateKey);
});

afterAll(async () => {
  jwksServer?.close();
  await h?.close();
});

describe('origins, native apps and CORS', () => {
  let key: string;
  beforeAll(async () => {
    key = (await channel({})).key;
  });

  it('anonymous: calls without an Origin are refused (config and CSAT included) unless native apps are allowed', async () => {
    const refused = await h.http().get(`/public/webchat/${key}/config`).expect(403);
    expect(refused.body.error.code).toBe('webchat_origin_required');
    await session(key, {}, null).expect(403);
    const visitor = (await session(key, {}).expect(200)).body.token;
    expect((await h.http().post(`/public/webchat/${key}/csat`).set(auth(visitor)).send({ score: 5 }).expect(403)).body.error.code).toBe('webchat_origin_required');
    await h.http().get(`/public/webchat/${key}/config`).set('origin', 'https://evil.test').expect(403);
    // The widget iframe's same-origin GETs carry no Origin, only Sec-Fetch-Site (history, stream).
    await h.http().get(`/public/webchat/${key}/messages`).set('sec-fetch-site', 'same-origin').set(auth(visitor)).expect(200);
    await h.http().get(`/public/webchat/${key}/messages`).set('sec-fetch-site', 'cross-site').set(auth(visitor)).expect(403);
    // Safari before 16.4 sends no Sec-Fetch-Site: the Referer (the widget page on OCSO's own origin) stands in.
    await h.http().get(`/public/webchat/${key}/messages`).set('referer', `${OCSO}/chat/${key}`).set(auth(visitor)).expect(200);
    await h.http().get(`/public/webchat/${key}/config`).set('referer', `${OCSO}/chat/${key}`).expect(200);
    await h.http().get(`/public/webchat/${key}/messages`).set('referer', 'https://evil.test/chat').set(auth(visitor)).expect(403);
    await h.http().get(`/public/webchat/${key}/messages`).set('referer', 'not a url').set(auth(visitor)).expect(403);
    // A browser that does send Sec-Fetch-Site is judged by it, whatever the Referer says.
    await h.http().get(`/public/webchat/${key}/messages`).set('sec-fetch-site', 'cross-site').set('referer', `${OCSO}/chat/${key}`).set(auth(visitor)).expect(403);
    const native = (await channel({ auth: { allowNativeApps: true } })).key;
    await h.http().get(`/public/webchat/${native}/config`).expect(200);
    await session(native, {}, null).expect(200);
  });

  it('answers preflights and responses with the allowed origin only (Vary: Origin, no credentials)', async () => {
    const pre = await h.http().options(`/public/webchat/${key}/messages`).set('origin', SHOP).set('access-control-request-method', 'POST').set('access-control-request-headers', 'authorization, content-type').expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe(SHOP);
    expect(pre.headers['access-control-allow-headers']).toContain('authorization');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, POST, OPTIONS');
    expect(pre.headers['access-control-allow-credentials']).toBeUndefined();
    expect(pre.headers['vary']).toContain('Origin');
    const evil = await h.http().options(`/public/webchat/${key}/messages`).set('origin', 'https://evil.test').set('access-control-request-method', 'POST').expect(204);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const config = await h.http().get(`/public/webchat/${key}/config`).set('origin', SHOP).expect(200);
    expect(config.headers['access-control-allow-origin']).toBe(SHOP);
    const any = (await channel({ allowedOrigins: [] })).key;
    expect((await h.http().get(`/public/webchat/${any}/config`).set('origin', 'https://anyone.test').expect(200)).headers['access-control-allow-origin']).toBe('https://anyone.test');
    // Vary: Origin also on origin-less responses, so a shared cache never mixes them with browser (CORS) ones.
    const native = (await channel({ auth: { mode: 'anonymous', allowNativeApps: true } })).key;
    const originless = await h.http().get(`/public/webchat/${native}/config`).expect(200);
    expect(originless.headers['access-control-allow-origin']).toBeUndefined();
    expect(originless.headers['vary']).toContain('Origin');
  });

  it('never CORS-enables session-pass: preflight refused, browser (Origin) calls refused', async () => {
    const pre = await h.http().options(`/public/webchat/${key}/session-pass`).set('origin', SHOP).set('access-control-request-method', 'POST').expect(403);
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
    const browser = await h.http().post(`/public/webchat/${key}/session-pass`).set('origin', SHOP).set(auth('sk_anything')).send({}).expect(403);
    expect(browser.body.error.code).toBe('webchat_session_pass_server_only');
    expect(browser.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('auth mode client: session passes', () => {
  let ch: { id: string; key: string; secretKey: string };
  beforeAll(async () => {
    ch = await channel({ auth: { mode: 'client' }, context: { allow: ['plan'] } });
  });

  it('shows the secret key once at creation (sk_…) and never again', async () => {
    expect(ch.secretKey).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    const read = await h.http().get(`/v1/channels/${ch.id}`).set(auth(admin)).expect(200);
    expect(read.text).not.toContain(ch.secretKey);
    expect(read.body.revealedSecrets).toBeUndefined();
  });

  it('mints single-use passes server-to-server with the secret key; the pass opens a session (no Origin needed)', async () => {
    await mint(ch.key, 'sk_wrong_key_000000000000000000000000000000').expect(401);
    expect((await h.http().post(`/public/webchat/${ch.key}/session-pass`).send({}).expect(401)).body.error.code).toBe('secret_key_invalid');
    const minted = await mint(ch.key, ch.secretKey, { context: { plan: 'gold', dropped: 'x' }, visitorId: 'v_app_device_01' }).expect(201);
    expect(minted.body).toEqual({ sessionPass: expect.stringMatching(/^wsp1\./), expiresAt: expect.any(String) });
    expect((await session(ch.key, {}).expect(401)).body.error.code).toBe('session_pass_required');
    const opened = await session(ch.key, { sessionPass: minted.body.sessionPass }, null).expect(200);
    expect(opened.body.visitorId).toBe('v_app_device_01');
    expect((await session(ch.key, { sessionPass: minted.body.sessionPass }).expect(401)).body.error.code).toBe('session_pass_used');
    // The trusted context reaches the conversation, labelled host.
    const sent = await send(ch.key, opened.body.token, 'hello from the app', null).expect(201);
    const [conv] = await h.db.db.select({ hostContext: conversations.hostContext }).from(conversations).where(eq(conversations.id, sent.body.conversationId));
    expect(conv!.hostContext).toMatchObject({ source: 'host', values: { plan: 'gold' } });
  });

  it('refuses visitor tokens that were not opened with a pass', async () => {
    const anonymousChannel = (await channel({})).key;
    const foreign = (await session(anonymousChannel, {}).expect(200)).body.token;
    await send(ch.key, foreign, 'hi').expect((r) => expect([401, 403]).toContain(r.status));
  });

  it('does not rate-limit minting with the right secret key (one pass per page view of a busy site)', async () => {
    const busy = await channel({ auth: { mode: 'client' } });
    for (let i = 0; i < 90; i++) await mint(busy.key, busy.secretKey).expect(201);
  });

  it('wrong secret keys cannot drain the channel bucket: they spend a per-address failure budget instead', async () => {
    const target = await channel({ auth: { mode: 'client' } });
    const bogus = `sk_${randomBytes(32).toString('base64url')}`;
    for (let i = 0; i < 30; i++) await mint(target.key, bogus).expect(401);
    const blocked = await mint(target.key, bogus).expect(429);
    expect(blocked.body.error.code).toBe('rate_limited');
    for (let i = 0; i < 60; i++) await mint(target.key, target.secretKey).expect(201);
  });

  it('rotating the secret key is an UPDATE proposal the checker sees; the old key stops working once approved', async () => {
    const next = `sk_${randomBytes(32).toString('base64url')}`;
    const proposal = await h.http().patch(`/v1/channels/${ch.id}`).set(auth(admin)).send({ secrets: { secretKey: next }, settings: { allowedOrigins: [SHOP], auth: { mode: 'client', allowNativeApps: true }, context: { allow: ['plan'] } }, approval: { checkerId: checker.id, reason: 'Rotate the secret key' } }).expect(202);
    const detail = await h.http().get(`/v1/approvals/${proposal.body.proposal.id}`).set(auth(checker.token)).expect(200);
    expect(detail.text).not.toContain(next);
    expect(detail.body.after.credentials).toMatchObject({ secretKey: 'new value (proposed)' });
    expect(detail.body.after.settings.auth).toEqual({ mode: 'client', allowNativeApps: true });
    await mint(ch.key, ch.secretKey).expect(201); // still the old key until approved
    await approveProposal(h, checker, proposal.body.proposal);
    await mint(ch.key, ch.secretKey).expect(401);
    await mint(ch.key, next).expect(201);
  });
});

describe('auth mode user: verified user tokens', () => {
  it('HS256: a user token directly or through a pass; missing or forged ones are refused', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    expect((await session(ch.key, {}).expect(401)).body.error.code).toBe('user_token_required');
    expect((await session(ch.key, { userToken: `${hs256({ sub: 'x' }).slice(0, -4)}AAAA` }).expect(401)).body.error.code).toBe('user_token_invalid');
    const direct = await session(ch.key, { userToken: hs256({ sub: 'cust-100', name: 'Asha' }) }).expect(200);
    expect(direct.body.authenticated).toBe(true);
    expect((await mint(ch.key, ch.secretKey).expect(401)).body.error.code).toBe('user_token_required');
    const pass = (await mint(ch.key, ch.secretKey, { userToken: hs256({ sub: 'cust-101' }) }).expect(201)).body.sessionPass;
    const viaPass = await session(ch.key, { sessionPass: pass }, null).expect(200);
    expect(viaPass.body.authenticated).toBe(true);
  });

  it('JWKS: tokens from the identity provider (issuer and audience checked)', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'jwks', jwksUrl: JWKS_URL, issuer: 'https://id.example.test', audience: 'ocso-chat' } } });
    const ok = await session(ch.key, { userToken: await signIdToken({ sub: 'idp-user-7' }) }).expect(200);
    expect(ok.body.authenticated).toBe(true);
    await send(ch.key, ok.body.token, 'signed in').expect(201);
    expect((await session(ch.key, { userToken: hs256({ sub: 'x' }) }).expect(401)).body.error.code).toBe('user_token_invalid');
  });
});

describe('anonymous context and tool identity passthrough', () => {
  it('an approved channel update drops held user tokens, so none is forwarded under the new policy', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } }, toolIdentity: 'passthrough' }, { hostJwtSecret: HS });
    const opened = await session(ch.key, { userToken: hs256({ sub: 'cust-950' }) }).expect(200);
    await send(ch.key, opened.body.token, 'hello').expect(201);
    expect(await h.db.db.select().from(webchatUserTokens).where(eq(webchatUserTokens.channelId, ch.id))).toHaveLength(1);
    const proposal = await h.http().patch(`/v1/channels/${ch.id}`).set(auth(admin)).send({ settings: { auth: { mode: 'user', userToken: { verify: 'hs256' } }, toolIdentity: 'ocso' }, approval: { checkerId: checker.id, reason: 'Stop passing user tokens to tools' } }).expect(202);
    await approveProposal(h, checker, proposal.body.proposal);
    expect(await h.db.db.select().from(webchatUserTokens).where(eq(webchatUserTokens.channelId, ch.id))).toHaveLength(0);
  });
  it('keeps browser context as unverified (client) on the conversation', async () => {
    const ch = await channel({ context: { allow: ['page'], maxBytes: 256 } });
    const opened = await session(ch.key, { context: { page: '/pricing', other: 'dropped' } }).expect(200);
    const sent = await send(ch.key, opened.body.token, 'question about pricing').expect(201);
    const [conv] = await h.db.db.select({ hostContext: conversations.hostContext }).from(conversations).where(eq(conversations.id, sent.body.conversationId));
    expect(conv!.hostContext).toMatchObject({ source: 'client', values: { page: '/pricing' } });
    expect((await session(ch.key, { context: { page: 'x'.repeat(500) } }).expect(400)).body.error.code).toBe('webchat_context_too_large');
  });

  it('forwards the held user token to opted-in MCP connections and signs claims with the verified customer ref', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } }, toolIdentity: 'passthrough', context: { allow: ['plan'] } }, { hostJwtSecret: HS });
    const userToken = hs256({ sub: 'cust-900', plan: 'gold' });
    const opened = await session(ch.key, { userToken }).expect(200);
    const sent = await send(ch.key, opened.body.token, 'what is my balance?').expect(201);
    const [held] = await h.db.db.select().from(webchatUserTokens).where(eq(webchatUserTokens.channelId, ch.id));
    expect(held!.tokenCiphertext).not.toContain(userToken.split('.')[1]!);
    const [conv] = await h.db.db.select().from(conversations).where(eq(conversations.id, sent.body.conversationId));
    expect(held!.customerId).toBe(conv!.customerId);

    // A fake MCP server (no auth of its own): the user token arrives as the bearer, the claims carry the customer ref.
    const demoUrl = new URL('../../../../packages/mcp/test/helpers/demo-server.ts', import.meta.url);
    const { startDemo } = (await import(demoUrl.href)) as { startDemo(a: Record<string, unknown>): Promise<{ url: string; server: http.Server; close(): Promise<void> }> };
    const demo = await startDemo({ mode: 'none' });
    const seen: Array<{ authorization?: string | undefined; claims?: string | undefined; userHeader?: string | undefined }> = [];
    const listeners = demo.server.listeners('request') as http.RequestListener[];
    demo.server.removeAllListeners('request');
    demo.server.on('request', (req, res) => {
      if (req.method === 'POST' && String(req.headers['mcp-method'] ?? '') === 'tools/call') {
        seen.push({ authorization: req.headers['authorization'], claims: req.headers['x-ocso-customer-claims'] as string, userHeader: req.headers['x-ocso-user-token'] as string });
      }
      for (const l of listeners) l.call(demo.server, req, res);
    });
    try {
      await h.db.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
      const secrets = h.app.get<SecretStore>(SECRET_STORE);
      const [adminRow] = await h.db.db.select({ id: users.id }).from(users).where(eq(users.email, ADMIN.email));
      const actor: ActorContext = { principal: { userId: adminRow!.id, role: 'TECH', displayName: 'Admin', teamIds: [], via: 'UI' }, correlationId: 'passthrough-test' };
      const svc = new McpConnectionService({ db: h.db.db, secrets, publicUrl: OCSO });
      const conn = await svc.createDraft(actor, { name: 'core', url: demo.url, network: 'INTERNAL' });
      await svc.discover(actor, conn.id);
      const tool = (await svc.listTools(actor, conn.id)).find((t) => t.name === 'crm.get_customer')!;
      await svc.classifyTools(actor, conn.id, { tools: [{ toolId: tool.id, riskClass: 'READ', approved: true }] });
      await svc.approve(actor, conn.id, { allowedAgentIds: '*', sendCustomerClaims: true, forwardUserToken: true });
      await approveInDb(h.db.db, actor, { objectKind: 'mcp_connection', objectId: conn.id, action: 'ACTIVATE' }, { secrets });
      await h.db.db.insert(agentToolGrants).values({ agentId, toolId: tool.id, enabled: true });

      const catalog = await loadAgentToolCatalog(h.db.db, agentId);
      const entry = [...catalog.entries.entries()].find(([, e]) => e.serverName === 'crm.get_customer')!;
      expect(entry[1].forwardUserToken).toBe(true);
      const factory = new McpToolProviderFactory(h.db.db, secrets, new SettingsService(h.db.db), { settingsTtlMs: 0, closeGraceMs: 10 });
      const runner = new ToolRunner(
        h.db.db,
        catalog,
        createToolProviderRegistry(h.db.db, connectionToolSource(MCP_TOOL_SOURCE, factory)),
        createAjvValidator(),
        h.app.get(CustomerClaimsIssuer),
        undefined,
        new HeldUserTokenSource(h.db.db, h.app.get(ChannelRuntime)),
      );
      const outcome = await runner.run(
        { toolCallId: 'tc_1', toolName: entry[0], input: { cif: '88214' } },
        { conversationId: conv!.id, turnId: uuidv7(), agentId, customerId: conv!.customerId, controlState: 'AI_ACTIVE', correlationId: 'passthrough', historyWindowStartSeq: 1 },
      );
      expect(outcome.status).toBe('SUCCEEDED');
      expect(seen.at(-1)?.authorization).toBe(`Bearer ${userToken}`);
      const claims = JSON.parse(Buffer.from(seen.at(-1)!.claims!.split('.')[1]!, 'base64url').toString());
      expect(claims).toMatchObject({ sub: 'cust-900', ocso_channel: ch.id, ctx: { plan: 'gold' }, cid: conv!.id });
      const forwarded = await h.db.db.select().from(auditEvents).where(eq(auditEvents.action, 'tool.user_token_forwarded'));
      expect(forwarded).toHaveLength(1);
      expect(JSON.stringify(forwarded)).not.toContain(userToken);
      await factory.close();
    } finally {
      await demo.close();
    }
  });
});

describe('signed-in users sharing a browser, and verified ids per channel', () => {
  const identitiesOf = (customerId: string) =>
    h.db.db.select({ kind: customerIdentities.kind, value: customerIdentities.value }).from(customerIdentities).where(eq(customerIdentities.customerId, customerId));
  const history = (key: string, token: string) => h.http().get(`/public/webchat/${key}/messages`).set('origin', SHOP).set(auth(token)).expect(200);
  const customerOf = async (conversationId: string) => (await h.db.db.select({ customerId: conversations.customerId }).from(conversations).where(eq(conversations.id, conversationId)))[0]!.customerId;

  it('Alice then Bob on one browser: Bob never sees, joins or links to Alice’s conversation, customer or token', async () => {
    const ch = await channel({ auth: { mode: 'anonymous', userToken: { verify: 'hs256' } }, toolIdentity: 'passthrough' }, { hostJwtSecret: HS });
    const aliceToken = hs256({ sub: 'alice' });
    const bobToken = hs256({ sub: 'bob' });
    // Alice chats as a guest, signs in, keeps chatting.
    const guest = (await session(ch.key, {}).expect(200)).body;
    await send(ch.key, guest.token, 'hello as a guest').expect(201);
    const alice = (await session(ch.key, { visitorToken: guest.token, userToken: aliceToken }).expect(200)).body;
    expect(alice.visitorId).toBe(guest.visitorId);
    const aliceConv = (await send(ch.key, alice.token, 'my card is blocked').expect(201)).body.conversationId;
    const aliceCustomer = await customerOf(aliceConv);

    // Alice leaves without signing out of the widget; Bob signs in on the same browser (same stored visitor token).
    const bob = (await session(ch.key, { visitorToken: alice.token, userToken: bobToken }).expect(200)).body;
    expect(bob.visitorId).not.toBe(alice.visitorId);
    expect((await history(ch.key, bob.token)).body).toMatchObject({ conversationId: null, messages: [] });
    const bobConv = (await send(ch.key, bob.token, 'hi, I am Bob').expect(201)).body.conversationId;
    expect(bobConv).not.toBe(aliceConv);
    const bobCustomer = await customerOf(bobConv);
    expect(bobCustomer).not.toBe(aliceCustomer);
    expect((await history(ch.key, alice.token)).body.conversationId).toBe(aliceConv);

    // No cross-linking: each customer holds only their own identities, and only their own held token.
    expect((await identitiesOf(aliceCustomer)).map((i) => i.value).sort()).toEqual([`${ch.id}:alice`, guest.visitorId].sort());
    expect((await identitiesOf(bobCustomer)).map((i) => i.value).sort()).toEqual([`${ch.id}:bob`, bob.visitorId].sort());
    const runtime = h.app.get(ChannelRuntime);
    const { adapter, config } = await runtime.load(ch.id);
    const open = async (conversationId: string) => {
      const held = await heldUserTokenFor(h.db.db, conversationId, new Date());
      return held ? (adapter as unknown as { embed: { openUserToken(c: unknown, s: string): string | null } }).embed.openUserToken(config, held.sealed) : null;
    };
    expect(await open(aliceConv)).toBe(aliceToken);
    expect(await open(bobConv)).toBe(bobToken);
  });

  it('a token that still links another user’s visitor (issued before the fix) never reaches the first user’s customer', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const alice = (await session(ch.key, { userToken: hs256({ sub: 'alice' }) }).expect(200)).body;
    const aliceConv = (await send(ch.key, alice.token, 'Alice here').expect(201)).body.conversationId;
    const aliceCustomer = await customerOf(aliceConv);
    // The old code issued Bob a token with Alice's visitor id as an alternate identity.
    const { config } = await h.app.get(ChannelRuntime).load(ch.id);
    const stale = issueVisitorToken({ channelId: ch.id, visitorId: alice.visitorId, externalCustomerRef: 'bob', proof: 'u', ttlSeconds: 600 }, config.secrets['visitorTokenSecret']!, new Date()).token;
    expect((await history(ch.key, stale)).body.conversationId).toBeNull();
    const bobConv = (await send(ch.key, stale, 'Bob here').expect(201)).body.conversationId;
    expect(bobConv).not.toBe(aliceConv);
    expect(await customerOf(bobConv)).not.toBe(aliceCustomer);
    expect((await identitiesOf(aliceCustomer)).map((i) => i.value)).not.toContain(`${ch.id}:bob`);
    expect((await identitiesOf(await customerOf(bobConv))).map((i) => i.value)).toEqual([`${ch.id}:bob`]);
  });

  it('two channels whose sites issue the same user id keep two customers; claims name the vouching channel only on its own conversations', async () => {
    const a = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const b = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const onA = (await session(a.key, { userToken: hs256({ sub: 'user-42' }) }).expect(200)).body;
    const onB = (await session(b.key, { userToken: hs256({ sub: 'user-42' }) }).expect(200)).body;
    const convA = (await send(a.key, onA.token, 'on site A').expect(201)).body.conversationId;
    const convB = (await send(b.key, onB.token, 'on site B').expect(201)).body.conversationId;
    const [custA, custB] = [await customerOf(convA), await customerOf(convB)];
    expect(custA).not.toBe(custB);
    expect((await identitiesOf(custA)).find((i) => i.kind === 'webchat_customer_ref')?.value).toBe(`${a.id}:user-42`);
    // A staff-made link across channels: the claims still present only the conversation's own channel's user id.
    await h.db.db.update(customerIdentities).set({ customerId: custA }).where(eq(customerIdentities.value, `${b.id}:user-42`));
    const claimsFor = async (conversationId: string) => {
      const token = await h.app.get(CustomerClaimsIssuer).issue({ customerId: custA, conversationId, agentId, connectionId: uuidv7(), scopes: [] });
      return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    };
    expect(await claimsFor(convA)).toMatchObject({ sub: 'user-42', ocso_channel: a.id });
    expect(await claimsFor(convB)).toMatchObject({ sub: 'user-42', ocso_channel: b.id });
    const unrelated = await channel({});
    const guest = (await session(unrelated.key, {}).expect(200)).body;
    const convC = (await send(unrelated.key, guest.token, 'elsewhere').expect(201)).body.conversationId;
    const other = await claimsFor(convC);
    expect(other['sub']).toBe(`ocso:customer:${custA}`);
    expect(other).not.toHaveProperty('ocso_channel');
  });
});
