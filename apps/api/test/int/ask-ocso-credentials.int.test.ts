import type http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { loadPrincipal } from '@ocso/application';
import type { Principal } from '@ocso/auth';
import { ModelGateway, UsageRecorder } from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import { SettingsService } from '@ocso/application';
import { deploymentSettings, internalAgentThreads, modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { AskOcsoTools, InternalActionService, InternalAgentService, type ActionCard, type AgentSink, type ToolOutcome } from '@ocso/internal-agent';
import { ADMIN, completeSetup, startApi, type ApiHarness } from './harness.js';
import { liveProvider, platformChecker, type Checker } from './platform.js';

/**
 * Credentials on Ask OCSO's confirmation card (PM/research/12 §9): the model makes the card from the non-secret
 * arguments; the user types credentials into the card's own fields; confirm puts them into the real route's body
 * for that one call. A generated key comes back once in the confirm response only. No value is ever stored by
 * Ask OCSO: every test greps the whole database (and the audit database) for the literal afterwards.
 */

interface DemoServer {
  url: string;
  server: http.Server;
  close(): Promise<void>;
}
async function startDemo(auth: Record<string, unknown>): Promise<DemoServer> {
  const helper = new URL('../../../../packages/mcp/test/helpers/demo-server.ts', import.meta.url);
  const mod = (await import(helper.href)) as { startDemo(a: Record<string, unknown>): Promise<DemoServer> };
  return mod.startDemo(auth);
}

let h: ApiHarness;
let admin: string;
let adminId: string;
let checker: Checker;
let tools: AskOcsoTools;
const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function principal(userId: string): Promise<Principal> {
  const { rows } = await h.db.pool.query<{ id: string }>(`SELECT id FROM auth_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  return (await loadPrincipal(h.db.db, userId, 'UI', rows[0]!.id))!;
}

let calls = 0;
async function run(name: string, args: Record<string, unknown>, threadId?: string): Promise<ToolOutcome & { threadId: string }> {
  const t = threadId ?? uuidv7();
  if (!threadId) await h.db.db.insert(internalAgentThreads).values({ id: t, userId: adminId });
  const outcome = await tools.run(await principal(adminId), { threadId: t, callId: `cred-call-${++calls}`, correlationId: `cred-${calls}` }, 'execute_tool', { name, args });
  return { ...outcome, threadId: t };
}

/** Every table (API and audit databases) whose rows contain the literal anywhere. */
async function tablesContaining(literal: string): Promise<string[]> {
  const hits: string[] = [];
  const scan = async (pool: pg.Pool, prefix: string) => {
    const { rows } = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    );
    for (const t of rows) {
      const r = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${t.table_schema}"."${t.table_name}" x WHERE x::text LIKE $1`, [`%${literal}%`]);
      if (r.rows[0]!.n > 0) hits.push(`${prefix}${t.table_schema}.${t.table_name}`);
    }
  };
  await scan(h.db.pool, '');
  const audit = new pg.Pool({ connectionString: h.auditDb.ownerUrl });
  try {
    await scan(audit, 'audit:');
  } finally {
    await audit.end();
  }
  return hits;
}

const confirm = (cardId: string, body: Record<string, unknown>) => h.http().post(`/v1/internal-agent/actions/${cardId}/confirm`).set(auth(admin)).send(body);

beforeAll(async () => {
  h = await startApi();
  admin = await completeSetup(h);
  adminId = (await h.db.pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ADMIN.email])).rows[0]!.id;
  checker = await platformChecker(h, 'Priya Checker');
  tools = h.app.get(AskOcsoTools);
});
afterAll(async () => {
  await h?.close();
});

describe('a model provider with its key, through the card', () => {
  const KEY = 'sk-ant-api03-card-only-7f3a9c1e5b';

  it('the card asks for the key; confirm needs it, puts it in the route body once, and nothing keeps it', async () => {
    const out = await run('models.create_provider', { kind: 'ANTHROPIC', name: 'Anthropic prod' });
    const card = out.card!;
    expect(card).toMatchObject({ tool: 'models.create_provider', kind: 'direct', status: 'PENDING', credentials: [{ key: 'apiKey', required: true }] });
    expect(card.credentials![0]!.label).toMatch(/api key/i);
    // The model hears which fields the card asks for, never a value, and is told not to ask in chat.
    expect(out.output.value).toMatchObject({ credentialsOnCard: [{ label: card.credentials![0]!.label, required: true }], note: expect.stringContaining('never ask for them in chat') });

    // A required field left blank: refused before anything runs; the card stays open to fill in.
    const blank = await confirm(card.id, { credentials: { apiKey: '' } }).expect(400);
    expect(blank.body.error.code).toBe('credential_required');
    const unknown = await confirm(card.id, { credentials: { apiKey: KEY, other: 'x-9f8e7d6c' } }).expect(400);
    expect(unknown.body.error.code).toBe('unknown_credential');
    expect(JSON.stringify(unknown.body)).not.toContain(KEY);

    const done = await confirm(card.id, { credentials: { apiKey: KEY } }).expect(200);
    expect(done.body).toMatchObject({ id: card.id, status: 'EXECUTED' });
    expect(done.body.reveal).toBeUndefined();
    const [row] = await h.db.db.select().from(modelProviders).where(eq(modelProviders.name, 'Anthropic prod'));
    expect(Object.keys(row!.secretRefs)).toEqual(['apiKey']);

    expect(JSON.stringify(done.body)).not.toContain(KEY);
    expect(await tablesContaining(KEY)).toEqual([]);
  });

  it('a credential the model supplies is refused, at any depth, and never stored in the thread', async () => {
    for (const args of [
      { kind: 'ANTHROPIC', name: 'Model-typed', credentials: { apiKey: 'sk-model-typed-1111' } },
      { kind: 'ANTHROPIC', name: 'Model-typed', settings: { apiKey: 'sk-model-typed-1111' } },
    ]) {
      const out = await run('models.create_provider', args);
      expect(out.card).toBeUndefined();
      expect(out.output).toMatchObject({ type: 'error', value: expect.stringContaining("confirmation card's own fields") });
      expect(String(out.output.value)).not.toContain('sk-model-typed-1111');
    }
    expect(await tablesContaining('sk-model-typed-1111')).toEqual([]);
  });

  it('rotating the key of a live provider is a governed card: staged as the UI stages it, the value never in the proposal', async () => {
    const live = await liveProvider<{ id: string }>(h, admin, checker, { kind: 'ANTHROPIC', name: 'Anthropic live', credentials: { apiKey: 'sk-ant-initial-0000' } });
    const out = await run('models.update_provider', { id: live.id });
    const card = out.card!;
    expect(card.kind).toBe('governed');
    expect(card.credentials).toEqual([expect.objectContaining({ key: 'apiKey', required: false, hint: expect.stringContaining('Leave blank to keep') })]);
    // Nothing typed and nothing else to change: refused, the card stays open.
    expect((await confirm(card.id, { checkerId: checker.id, reason: 'Rotate the key' }).expect(400)).body.error.code).toBe('credential_required');
    const ROTATED = 'sk-ant-rotated-5e6f7a8b9c';
    const sent = await confirm(card.id, { checkerId: checker.id, reason: 'Rotate the key', credentials: { apiKey: ROTATED } }).expect(200);
    expect(sent.body).toMatchObject({ status: 'SUBMITTED', result: { proposalId: expect.any(String) } });
    expect(await tablesContaining(ROTATED)).toEqual([]);
  });
});

describe('a web chat channel: the generated secret key is shown once', () => {
  it('confirm hands the key back once in `reveal`; the stored card, thread, audit and model history never hold it', async () => {
    const providerId = uuidv7();
    await h.db.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted creds' });
    const profileId = uuidv7();
    await h.db.db.insert(modelProfiles).values({ id: profileId, name: 'ask-ocso-creds', providerId, model: 'scripted', retries: 0 });
    await h.db.db.update(deploymentSettings).set({ internalAgentProfileId: profileId }).where(eq(deploymentSettings.id, 1));
    try {
      const adapter = new ScriptedAdapter(providerId);
      const gateway = new ModelGateway(h.db.db, { get: async () => adapter }, new UsageRecorder(h.db.db), new SettingsService(h.db.db));
      const agent = new InternalAgentService(h.db.db, gateway, tools, h.app.get(InternalActionService));
      const cards: ActionCard[] = [];
      const sink: AgentSink = { text: () => {}, step: () => {}, links: () => {}, table: () => {}, card: (c) => cards.push(c), denied: () => {} };
      adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'channels.create_channel', args: { kind: 'WEBCHAT', name: 'Website chat' } } }] }, { text: 'Confirm the card to create it.' }];
      const { threadId } = await agent.ask(await principal(adminId), null, 'Add a web chat channel for the website', sink, 'creds-webchat-1');
      const card = cards[0]!;
      expect(card).toMatchObject({ tool: 'channels.create_channel', status: 'PENDING' });
      const byKey = Object.fromEntries(card.credentials!.map((c) => [c.key, c]));
      expect(byKey['secretKey']).toMatchObject({ required: false, generate: true });
      expect(byKey['visitorTokenSecret']).toMatchObject({ required: false, generate: true });
      expect(byKey['hostJwtSecret']).toMatchObject({ required: false });
      expect(byKey['hostJwtSecret']?.generate).toBeUndefined();

      const done = await confirm(card.id, {}).expect(200);
      expect(done.body.status).toBe('EXECUTED');
      expect(done.body.reveal).toEqual([{ key: 'secretKey', label: 'Secret key', value: expect.stringMatching(/^sk_/) }]);
      const key = done.body.reveal[0].value as string;
      expect(done.body.result.message).toMatch(/Secret key issued and shown once to the user/);
      expect(JSON.stringify({ ...done.body, reveal: null })).not.toContain(key);

      // Not on the stored card, in the thread's history or on a re-read.
      const again = await h.http().get(`/v1/internal-agent/actions/${card.id}`).set(auth(admin)).expect(200);
      expect(again.body.reveal).toBeUndefined();
      expect(JSON.stringify(again.body)).not.toContain(key);
      const history = await h.http().get(`/v1/internal-agent/threads/${threadId}/messages`).set(auth(admin)).expect(200);
      expect(JSON.stringify(history.body)).not.toContain(key);

      // The model's next turn hears only that a key was issued and shown once.
      adapter.script = [{ text: 'It is set up.' }];
      await agent.ask(await principal(adminId), threadId, 'Did it work?', sink, 'creds-webchat-2');
      const seen = JSON.stringify(adapter.requests.at(-1));
      expect(seen).toContain('shown once to the user');
      expect(seen).not.toContain(key);

      // The channel really has it (it authenticates), and no table besides the encrypted secret store holds it.
      expect(await tablesContaining(key)).toEqual([]);
      const channel = (await h.http().get(`/v1/channels/${String((await h.db.pool.query<{ id: string }>(`SELECT id FROM channels WHERE name = 'Website chat'`)).rows[0]!.id)}`).set(auth(admin)).expect(200)).body;
      expect(Object.keys(channel.secretRefs ?? channel.secrets ?? {})).toEqual(expect.arrayContaining(['secretKey']));
    } finally {
      await h.db.db.update(deploymentSettings).set({ internalAgentProfileId: null }).where(eq(deploymentSettings.id, 1));
    }
  });

  it('a Twilio channel needs its required secrets on the card; the values reach the route and nothing keeps them', async () => {
    const out = await run('channels.create_channel', { kind: 'TWILIO_WHATSAPP', name: 'Twilio WA', settings: { accountSid: `AC${'0a'.repeat(16)}`, from: 'whatsapp:+14155238886' } });
    const card = out.card;
    if (!card) throw new Error(`no card: ${JSON.stringify(out.output.value)}`);
    const required = card.credentials!.filter((c) => c.required).map((c) => c.key);
    expect(required).toEqual(['authToken']);
    expect(card.warnings[0]).toMatch(/customer channel/);
    expect((await confirm(card.id, {}).expect(400)).body.error.code).toBe('credential_required');
    const TOKEN = 'twilio-auth-token-4d5e6f708192';
    const values = Object.fromEntries(required.map((k, i) => [k, `${TOKEN}-${i}`]));
    const done = await confirm(card.id, { credentials: values }).expect(200);
    expect(done.body.status, JSON.stringify(done.body.result)).toBe('EXECUTED');
    expect(JSON.stringify(done.body)).not.toContain(TOKEN);
    expect(await tablesContaining(TOKEN)).toEqual([]);
  });
});

describe('an MCP connection header token, through the card', () => {
  const TOKEN = 'mcp-bearer-token-on-card-31415';
  let demo: DemoServer;
  beforeAll(async () => {
    await h.db.pool.query(`UPDATE deployment_settings SET egress_allowed_internal_hosts = ARRAY['127.0.0.1']`);
    demo = await startDemo({ mode: 'bearer', token: TOKEN });
  });
  afterAll(async () => {
    await demo?.close();
  });

  it('the header name comes from the model, the token only from the card; discovery signs in with it', async () => {
    const created = await h.http().post('/v1/mcp/connections').set(auth(admin)).send({ name: 'core-crm', url: demo.url, network: 'INTERNAL' }).expect(201);
    const id = created.body.id as string;
    // The model may not pass the token.
    const typed = await run('mcp.set_connection_header_auth', { id, headerName: 'Authorization', token: `Bearer ${TOKEN}` });
    expect(typed.output.type).toBe('error');
    const out = await run('mcp.set_connection_header_auth', { id, headerName: 'Authorization' });
    const card = out.card!;
    expect(card).toMatchObject({ kind: 'direct', credentials: [{ key: 'token', label: 'Token', required: true }] });
    expect(card.warnings[0]).toMatch(/external connection/);
    const done = await confirm(card.id, { credentials: { token: `Bearer ${TOKEN}` } }).expect(200);
    expect(done.body.status, JSON.stringify(done.body.result)).toBe('EXECUTED');
    const tools = await h.http().get(`/v1/mcp/connections/${id}/tools`).set(auth(admin)).expect(200);
    expect((tools.body as unknown[]).length).toBeGreaterThan(0);
    expect(await tablesContaining(TOKEN)).toEqual([]);
  });
});
