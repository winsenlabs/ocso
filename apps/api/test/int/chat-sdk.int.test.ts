import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createOcsoChat, memoryStorage, type ChatMessage, type ChatState, type FetchLike, type OcsoChatClient, type OcsoChatOptions } from '@winsendotai/ocso-chat';
import { RouterService, RoutingEngine, SettingsService, recordInstalledApproval, systemActor } from '@ocso/application';
import { ChannelRegistry } from '@ocso/channels';
import { conversations, customerIdentities, interactionParts, interactions, modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { InMemorySecretRows, LocalSecretStore, parseMasterKey } from '@ocso/secrets';
import { LocalBlobStore } from '@ocso/blob';
import { MemoryQueue } from '@ocso/queue';
import { createAjvValidator } from '@ocso/tools';
import { createLogger } from '@ocso/observability';
import { ChannelRuntime, ContextBuilder, HotContextCache, LeaseManager, MediaMaterializer, ModelGateway, ToolRunner, TurnProcessor, UsageRecorder, createToolProviderRegistry } from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import { liveChannel, type Checker } from './platform.js';
import { completeSetup, startApi, type ApiHarness } from './harness.js';
import { routeChannel } from './routing.js';
import { setTeams } from './teams.js';

/**
 * The public headless client (@winsendotai/ocso-chat) against the REAL web chat API over real sockets:
 * Node's fetch streams the SSE body, the scripted model answers through the turn processor, and every
 * auth mode (anonymous, client session passes, verified user tokens) goes through the real endpoints.
 */

const SHOP = 'https://shop.example.test';
const HS = 'host-identity-secret-0123456789-abcdefghij';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const hs256 = (claims: Record<string, unknown>) => {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ exp: Math.floor(Date.now() / 1000) + 900, ...claims });
  return `${head}.${body}.${createHmac('sha256', HS).update(`${head}.${body}`).digest('base64url')}`;
};

let h: ApiHarness;
let admin: string;
let lead: string;
let checker: Checker;
let agentId: string;
let queueId: string;
let baseUrl: string;
let processor: TurnProcessor;
const adapter = { current: null as ScriptedAdapter | null };
const clients: OcsoChatClient[] = [];

/** A browser on the shop's page: the platform fetch with the page's Origin (what a browser adds by itself). */
const browserFetch: FetchLike = (input, init = {}) => fetch(input, { ...init, headers: { ...(init.headers ?? {}), origin: SHOP } }) as never;

function chat(key: string, options: Partial<OcsoChatOptions> = {}): OcsoChatClient {
  const client = createOcsoChat({ baseUrl, publishableKey: key, storage: memoryStorage(), fetch: browserFetch, ...options });
  clients.push(client);
  return client;
}

/** Wait until the client's state satisfies `check` (state changes are pushed; also re-checked on a timer). */
function until(client: OcsoChatClient, check: (s: ChatState) => boolean, what: string, timeoutMs = 15_000): Promise<ChatState> {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (s: ChatState) => {
      if (done || !check(s)) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      off();
      resolve(s);
    };
    const off = client.subscribe(finish);
    const timer = setInterval(() => finish(client.getState()), 50);
    const timeout = setTimeout(() => {
      done = true;
      clearInterval(timer);
      off();
      reject(new Error(`timed out waiting for ${what}; state: ${JSON.stringify({ ...client.getState(), config: undefined })}`));
    }, timeoutMs);
    finish(client.getState());
  });
}

const textOf = (m: ChatMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
const assistantSaid = (text: string) => (s: ChatState) => s.messages.some((m) => m.role === 'assistant' && !m.streaming && textOf(m) === text);

const runTurn = (conversationId: string) =>
  processor.handle({ id: uuidv7(), topic: 'conversation.turn', payload: { conversationId }, groupKey: conversationId, attempt: 1, enqueuedAt: new Date() });

/** Send, then let the scripted model answer the conversation (what the worker does on `conversation.turn`). */
async function exchange(client: OcsoChatClient, text: string, reply: string): Promise<void> {
  await client.send(text);
  const conversationId = client.getState().conversationId;
  expect(conversationId).toEqual(expect.any(String));
  adapter.current!.script = [{ text: reply }];
  await runTurn(conversationId!);
}

async function channel(settings: Record<string, unknown>, secrets: Record<string, string> = {}, route = true): Promise<{ id: string; key: string; secretKey: string }> {
  const created = await liveChannel<{ id: string; publicKey: string; revealedSecrets?: Record<string, string> }>(h, admin, checker, {
    kind: 'WEBCHAT',
    name: `SDK ${randomBytes(3).toString('hex')}`,
    settings: { allowedOrigins: [SHOP], ...settings },
    secrets,
  });
  if (route) await routeChannel(h, created.id, agentId, queueId);
  return { id: created.id, key: created.publicKey, secretKey: created.revealedSecrets!['secretKey']! };
}

async function hostContextOf(conversationId: string) {
  const [row] = await h.db.db.select({ hostContext: conversations.hostContext, customerId: conversations.customerId }).from(conversations).where(eq(conversations.id, conversationId));
  return row!;
}

const identitiesOf = (customerId: string) => h.db.db.select({ kind: customerIdentities.kind, value: customerIdentities.value, verified: customerIdentities.verified }).from(customerIdentities).where(eq(customerIdentities.customerId, customerId));

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  const leadId = (await h.http().post('/v1/users').set(auth(admin)).send({ email: 'lead@ocso.test', name: 'Lena Lead', role: 'HEAD', password: 'a password 12345' }).expect(201)).body.id;
  lead = await h.loginAs('lead@ocso.test', 'a password 12345');
  checker = { id: leadId, token: lead };
  const team = (await h.http().post('/v1/teams').set(auth(lead)).send({ name: 'Web' }).expect(201)).body.id;
  await setTeams(h, admin, leadId, [team]);
  queueId = (await h.http().post('/v1/queues').set(auth(lead)).send({ name: 'Web tier 1', teamIds: [team] }).expect(201)).body.id;
  const provider = uuidv7();
  await h.db.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profile = uuidv7();
  await h.db.db.insert(modelProfiles).values({ id: profile, name: 'sdk-primary', providerId: provider, model: 'scripted', retries: 0 });
  await recordInstalledApproval(h.db.db, { kind: 'model_profile', id: profile, title: 'sdk-primary' }, 'Test fixture: existing profile');
  agentId = (await h.http().post('/v1/agents').set(auth(lead)).send({ name: 'Maya', purpose: 'support', conversationType: 'SUPPORT', modelProfileId: profile, defaultQueueId: queueId, teamIds: [team] }).expect(201)).body.id;
  await h.http().post(`/v1/agents/${agentId}/status`).set(auth(lead)).send({ status: 'LIVE', approval: { bootstrap: true, reason: 'Sole Head' } }).expect(202);

  adapter.current = new ScriptedAdapter(provider);
  processor = new TurnProcessor({
    db: h.db.db,
    queue: new MemoryQueue(),
    leases: new LeaseManager(h.db.db, 'sdk-worker', { leaseSeconds: 30, idleSeconds: 30 }),
    gateway: new ModelGateway(h.db.db, { get: async () => adapter.current! }, new UsageRecorder(h.db.db), new SettingsService(h.db.db)),
    context: new ContextBuilder(h.db.db, new HotContextCache(), { historyWindow: 20, mediaWindow: 6, timezone: 'UTC' }),
    media: new MediaMaterializer(h.db.db, new ChannelRuntime(h.db.db, new ChannelRegistry(), new LocalSecretStore(new InMemorySecretRows(), parseMasterKey('k', randomBytes(32).toString('base64')))), new LocalBlobStore({ rootDir: '/tmp/ocso-sdk', publicApiBaseUrl: 'http://x', signingKey: 'k' })),
    toolRunner: (catalog) => new ToolRunner(h.db.db, catalog, createToolProviderRegistry(h.db.db), createAjvValidator(), null),
    capabilitiesFor: async () => ({ imageInput: true, fileInput: true, audioInput: false }),
    logger: createLogger({ service: 'test', version: '0', level: 'fatal' }),
    summarizeAfter: 40,
  });

  // Real sockets: Node's fetch must stream the SSE body from a listening server.
  await h.app.listen(0, '127.0.0.1');
  const address = h.app.getHttpServer().address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
});

afterAll(async () => {
  for (const c of clients.splice(0)) c.disconnect();
  await h?.close();
});

describe('anonymous mode', () => {
  let key: string;
  beforeAll(async () => {
    key = (await channel({ context: { allow: ['page'] } })).key;
  });

  it('(a) SSE: connects, sends, and receives the streamed assistant reply', async () => {
    const client = chat(key, { transport: 'sse' });
    let streamed = false;
    client.subscribe((s) => (streamed ||= s.messages.some((m) => m.streaming && m.role === 'assistant')));
    await client.connect();
    const ready = await until(client, (s) => s.status === 'ready', 'ready');
    expect(ready).toMatchObject({ mode: 'ai', transport: 'sse', error: null, authenticated: false, messages: [] });
    await until(client, (s) => s.config !== null, 'config');
    expect(client.getState().config).toMatchObject({ assistantName: 'Maya', allowedOrigins: [SHOP] });

    await exchange(client, 'Hello there', 'Hi! How can I help?');
    const state = await until(client, assistantSaid('Hi! How can I help?'), 'assistant reply');
    expect(streamed).toBe(true); // the delta draft arrived before the stored message
    expect(state.status).toBe('ready');
    expect(state.mode).toBe('ai');
    expect(state.typing).toBeNull();
    expect(state.messages.map((m) => ({ role: m.role, parts: m.parts, status: m.status, author: m.author }))).toEqual([
      { role: 'customer', parts: [{ type: 'text', text: 'Hello there' }], status: 'sent', author: undefined },
      { role: 'assistant', parts: [{ type: 'text', text: 'Hi! How can I help?' }], status: undefined, author: { name: 'Maya' } },
    ]);
    expect(state.messages[0]!.id).toMatch(/^c:cm_[0-9a-f]{32}$/);
    expect(state.messages.every((m) => typeof m.seq === 'number')).toBe(true);
    expect(state.agentName).toBe('Maya');
    expect(await client.rateCsat(5, 'quick answer')).toMatchObject({ recorded: true, score: 5 });
  });

  it('(b) poll transport: the same conversation flow without a stream', async () => {
    const client = chat(key, { transport: 'poll', pollIntervalMs: 150 });
    await client.connect();
    await until(client, (s) => s.status === 'ready', 'ready');
    expect(client.getState().transport).toBe('poll');
    await exchange(client, 'Polling works?', 'Yes, it does.');
    const state = await until(client, assistantSaid('Yes, it does.'), 'assistant reply');
    expect(state.messages.map((m) => [m.role, textOf(m)])).toEqual([
      ['customer', 'Polling works?'],
      ['assistant', 'Yes, it does.'],
    ]);
    expect(state.mode).toBe('ai');
  });

  it('(e) page context from the browser lands on the conversation, filtered and marked unverified', async () => {
    const client = chat(key, { context: { page: '/pricing', plan: 'forged' } });
    await client.connect();
    await client.send('question about pricing');
    const conv = await hostContextOf(client.getState().conversationId!);
    expect(conv.hostContext).toMatchObject({ source: 'client', values: { page: '/pricing' } });
    expect((conv.hostContext as { values: Record<string, unknown> }).values).not.toHaveProperty('plan');
  });

  it('(g) disconnect, a reply arrives meanwhile, reconnect gap-fills it; a reload restores the history', async () => {
    const storage = memoryStorage();
    const client = chat(key, { storage, transport: 'sse' });
    await client.connect();
    await until(client, (s) => s.status === 'ready', 'ready');
    await exchange(client, 'first question', 'first answer');
    await until(client, assistantSaid('first answer'), 'first answer');

    await client.send('second question');
    client.disconnect();
    expect(client.getState().status).toBe('idle');
    adapter.current!.script = [{ text: 'second answer (while you were away)' }];
    await runTurn(client.getState().conversationId!);
    await new Promise((r) => setTimeout(r, 300));
    expect(assistantSaid('second answer (while you were away)')(client.getState())).toBe(false);

    await client.connect();
    const state = await until(client, assistantSaid('second answer (while you were away)'), 'gap-filled reply');
    expect(state.messages.map((m) => [m.role, textOf(m)])).toEqual([
      ['customer', 'first question'],
      ['assistant', 'first answer'],
      ['customer', 'second question'],
      ['assistant', 'second answer (while you were away)'],
    ]);
    await until(client, (s) => s.status === 'ready', 'ready again');

    // A reload (new client, same storage) resumes the same visitor and conversation.
    client.disconnect();
    const reloaded = chat(key, { storage, transport: 'sse' });
    await reloaded.connect();
    const restored = await until(reloaded, (s) => s.messages.length === 4, 'restored history');
    expect(restored.conversationId).toBe(state.conversationId);
    expect(restored.messages.map((m) => m.id)).toEqual(state.messages.map((m) => m.id));
  });

  it('refuses a site outside the allowlist with the server error code', async () => {
    const client = chat(key, { fetch: ((input: string, init: { headers?: Record<string, string> } = {}) => fetch(input, { ...init, headers: { ...init.headers, origin: 'https://evil.test' } })) as FetchLike });
    await expect(client.connect()).rejects.toMatchObject({ code: 'webchat_origin_not_allowed', status: 403 });
    expect(client.getState()).toMatchObject({ status: 'error', error: { code: 'webchat_origin_not_allowed' } });
  });
});

describe('client mode (session passes)', () => {
  let ch: { id: string; key: string; secretKey: string };
  beforeAll(async () => {
    ch = await channel({ auth: { mode: 'client' }, context: { allow: ['plan'] } });
  });

  /** The host's backend: mints a pass with the secret key (server-to-server, no Origin). */
  const mintPass = (body: Record<string, unknown> = {}) => async () => {
    const res = await fetch(`${baseUrl}/public/webchat/${ch.key}/session-pass`, { method: 'POST', headers: { ...auth(ch.secretKey), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 201) throw new Error(`session-pass → ${res.status} ${await res.text()}`);
    return ((await res.json()) as { sessionPass: string }).sessionPass;
  };

  it('(c) getSessionPass: a native app (no Origin) connects with a pass minted by the real endpoint', async () => {
    let minted = 0;
    const getSessionPass = mintPass({ context: { plan: 'gold', ignored: 'x' } });
    const client = chat(ch.key, { fetch: fetch as unknown as FetchLike, mode: 'client', getSessionPass: () => ((minted += 1), getSessionPass()) });
    await client.connect();
    await until(client, (s) => s.status === 'ready', 'ready');
    expect(minted).toBe(1);
    await exchange(client, 'hello from the app', 'Hello, gold member!');
    await until(client, assistantSaid('Hello, gold member!'), 'reply');
    const conv = await hostContextOf(client.getState().conversationId!);
    expect(conv.hostContext).toMatchObject({ source: 'host', values: { plan: 'gold' } });

    // Passes are single-use: a reconnect (new session exchange) mints another.
    client.disconnect();
    await client.connect();
    await until(client, (s) => s.status === 'ready' && s.messages.length === 2, 'reconnected');
    expect(minted).toBe(2);
  });

  it('(c) without getSessionPass the connect fails with session_pass_required', async () => {
    const client = chat(ch.key, { fetch: fetch as unknown as FetchLike });
    await expect(client.connect()).rejects.toMatchObject({ code: 'session_pass_required', status: 401 });
    expect(client.getState()).toMatchObject({ status: 'error', error: { code: 'session_pass_required' } });
  });
});

describe('user mode (HS256 user tokens)', () => {
  it('(d) getUserToken: the session is verified and the conversation belongs to the customer ref', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const client = chat(ch.key, { mode: 'user', getUserToken: async () => hs256({ sub: 'cust-200', name: 'Asha' }) });
    await client.connect();
    const ready = await until(client, (s) => s.status === 'ready', 'ready');
    expect(ready.authenticated).toBe(true);
    await exchange(client, 'signed-in question', 'Hi Asha.');
    await until(client, assistantSaid('Hi Asha.'), 'reply');
    const conv = await hostContextOf(client.getState().conversationId!);
    expect(await identitiesOf(conv.customerId)).toContainEqual(expect.objectContaining({ value: expect.stringContaining('cust-200'), verified: true }));

    // Without a token, user mode is refused with the documented code.
    const anonymous = chat(ch.key, { getUserToken: async () => null });
    await expect(anonymous.connect()).rejects.toMatchObject({ code: 'user_token_required' });
  });

  it('(d) identify(): a user-mode visitor refused without a token signs in, then connects', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const client = chat(ch.key);
    await expect(client.connect()).rejects.toMatchObject({ code: 'user_token_required' });
    await client.identify(hs256({ sub: 'cust-201' }));
    const ready = await until(client, (s) => s.status === 'ready', 'ready after identify');
    expect(ready.authenticated).toBe(true);
    await client.send('now signed in');
    expect(client.getState().messages.at(-1)).toMatchObject({ role: 'customer', status: 'sent' });
  });

  it('(d) identify(): an anonymous visitor on a channel that verifies HS256 tokens becomes authenticated', async () => {
    const ch = await channel({ auth: { mode: 'anonymous', userToken: { verify: 'hs256' } } }, { hostJwtSecret: HS });
    const client = chat(ch.key);
    await client.connect();
    await until(client, (s) => s.status === 'ready', 'ready');
    expect(client.getState().authenticated).toBe(false);
    await client.identify(hs256({ sub: 'cust-202' }));
    await until(client, (s) => s.status === 'ready' && s.authenticated, 'identified');
    await client.send('who am I?');
    const conv = await hostContextOf(client.getState().conversationId!);
    expect(await identitiesOf(conv.customerId)).toContainEqual(expect.objectContaining({ value: expect.stringContaining('cust-202'), verified: true }));
  });
});

describe('shared browser', () => {
  it('Alice signs in, leaves without reset(); Bob signs in on the same storage and sees none of her conversation', async () => {
    const ch = await channel({ auth: { mode: 'user', userToken: { verify: 'hs256' } }, toolIdentity: 'passthrough' }, { hostJwtSecret: HS });
    const storage = memoryStorage();
    let who = 'alice';
    const getUserToken = async () => hs256({ sub: who });
    const alice = chat(ch.key, { storage, mode: 'user', getUserToken });
    await alice.connect();
    await until(alice, (s) => s.status === 'ready', 'alice ready');
    await exchange(alice, 'my card is blocked', 'Let me check, Alice.');
    await until(alice, assistantSaid('Let me check, Alice.'), 'alice reply');
    const aliceConv = alice.getState().conversationId!;
    alice.disconnect();

    who = 'bob';
    const bob = chat(ch.key, { storage, mode: 'user', getUserToken });
    await bob.connect();
    const ready = await until(bob, (s) => s.status === 'ready', 'bob ready');
    expect(ready.authenticated).toBe(true);
    expect(ready.messages).toEqual([]);
    expect(ready.conversationId).toBeNull();
    await bob.send('hi, Bob here');
    const bobConv = bob.getState().conversationId!;
    expect(bobConv).not.toBe(aliceConv);
    const [a, b] = [await hostContextOf(aliceConv), await hostContextOf(bobConv)];
    expect(a.customerId).not.toBe(b.customerId);
    expect((await identitiesOf(a.customerId)).map((i) => i.value)).not.toContain(`${ch.id}:bob`);
    expect((await identitiesOf(b.customerId)).map((i) => i.value)).not.toContain(`${ch.id}:alice`);

    // The server alone keeps them apart too: an SDK that still sends Alice's stored visitor token (no hint).
    const aliceToken = (await h.http().post(`/public/webchat/${ch.key}/session`).set('origin', SHOP).send({ userToken: hs256({ sub: 'alice' }) }).expect(200)).body.token;
    const bobRaw = await h.http().post(`/public/webchat/${ch.key}/session`).set('origin', SHOP).send({ visitorToken: aliceToken, userToken: hs256({ sub: 'bob' }) }).expect(200);
    const seen = await h.http().get(`/public/webchat/${ch.key}/messages`).set('origin', SHOP).set(auth(bobRaw.body.token)).expect(200);
    expect(seen.body.conversationId).toBe(bobConv);
  });
});

describe('choices', () => {
  it('(f) a router CHOICES question renders as a choices part; sendChoice sends the structured reply the router understands', async () => {
    const ch = await channel({}, {}, false);
    const definition = {
      steps: [
        {
          id: 'topic',
          kind: 'ASK',
          attribute: 'topic',
          prompt: { text: 'What can we help with?' },
          options: [
            { value: 'cards', label: 'Cards & EMI' },
            { value: 'loans', label: 'Loans' },
          ],
          maxAttempts: 2,
          skipIfKnown: false,
        },
      ],
      rules: [{ when: { topic: 'loans' }, queueId }],
      fallbackQueueId: queueId,
      returning: null,
      timeoutMinutes: 10,
    };
    const router = (await h.http().post('/v1/routers').set(auth(lead)).send({ name: 'SDK menu', definition }).expect(201)).body.id;
    const version = (await h.http().post(`/v1/routers/${router}/versions`).set(auth(lead)).send({ reason: 'sdk' }).expect(201)).body.id;
    await h.db.db.transaction(async (tx) => {
      await RouterService.activateVersion(tx, systemActor('test', 't'), version);
      await RouterService.attachChannels(tx, systemActor('test', 't'), router, [ch.id]);
    });
    const engine = new RoutingEngine({ db: h.db.db, queue: new MemoryQueue() });

    const client = chat(ch.key, { transport: 'sse' });
    await client.connect();
    await until(client, (s) => s.status === 'ready', 'ready');
    await client.send('hi');
    const conversationId = client.getState().conversationId!;
    await engine.advance(conversationId, 'r1');
    const asked = await until(client, (s) => s.messages.some((m) => m.parts.some((p) => p.type === 'choices')), 'choices');
    const question = asked.messages.find((m) => m.parts.some((p) => p.type === 'choices'))!;
    expect(question.role).toBe('assistant');
    const part = question.parts.find((p) => p.type === 'choices') as Extract<ChatMessage['parts'][number], { type: 'choices' }>;
    expect(part).toMatchObject({ prompt: 'What can we help with?', options: [{ label: 'Cards & EMI' }, { label: 'Loans' }] });

    const loans = part.options.find((o) => o.label === 'Loans')!;
    await client.sendChoice(loans);
    const [sent] = await h.db.db
      .select({ content: interactionParts.content })
      .from(interactions)
      .innerJoin(interactionParts, eq(interactionParts.interactionId, interactions.id))
      .where(eq(interactions.conversationId, conversationId))
      .orderBy(interactions.seq)
      .then((rows) => rows.filter((r) => (r.content as { type: string }).type === 'STRUCTURED' && (r.content as { schema: string }).schema !== 'ocso.choices' && (r.content as { schema: string }).schema !== 'system.control_changed').slice(-1));
    expect(sent!.content).toMatchObject({ type: 'STRUCTURED', data: { id: loans.id }, fallbackText: 'Loans' });
    expect(client.getState().messages.at(-1)).toMatchObject({ role: 'customer', status: 'sent', parts: [{ type: 'text', text: 'Loans' }] });

    await engine.advance(conversationId, 'r2');
    const detail = (await h.http().get(`/v1/conversations/${conversationId}`).set(auth(lead)).expect(200)).body;
    expect(detail).toMatchObject({ controlState: 'AI_ACTIVE', routing: { outcome: 'RULE', attributes: { topic: 'loans' } } });
  });
});

describe('CORS', () => {
  it('(h) preflights from an allowed origin get the allow headers; others do not', async () => {
    const { key } = await channel({});
    const preflight = (origin: string) =>
      fetch(`${baseUrl}/public/webchat/${key}/messages`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } });
    const ok = await preflight(SHOP);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(SHOP);
    expect(ok.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(ok.headers.get('access-control-allow-headers')).toContain('content-type');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    expect(ok.headers.get('vary')).toContain('Origin');
    const evil = await preflight('https://evil.test');
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
    expect(evil.headers.get('access-control-allow-headers')).toBeNull();
    // The stream the client opens is CORS-readable from the allowed site too.
    const cfg = await fetch(`${baseUrl}/public/webchat/${key}/config`, { headers: { origin: SHOP } });
    expect(cfg.headers.get('access-control-allow-origin')).toBe(SHOP);
  });
});
