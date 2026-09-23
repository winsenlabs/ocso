import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { deploymentSettings, internalAgentActions, modelProfiles, modelProviders, uuidv7 } from '@ocso/db';
import { SettingsService } from '@ocso/application';
import { ModelGateway, UsageRecorder } from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import type { Principal } from '@ocso/auth';
import { AskOcsoTools, InternalActionService, InternalAgentService, type ActionCard, type AgentSink, type CapabilityCall, type CapabilityRunner, type DelegationScope } from '../src/index.js';

/**
 * The Ask OCSO loop over the meta tools (PM/research/12 §4) with a scripted model and a recording runner in
 * place of the API's loopback runner (apps/api/test/int/ask-ocso.int.test.ts runs the real one).
 */

let t: TestDatabase;
let adapter: ScriptedAdapter;
let agent: InternalAgentService;
let actions: InternalActionService;
const calls: Array<{ scope: DelegationScope; call: CapabilityCall }> = [];
const teamId = '01a0cf3e-0000-7000-8000-000000000001';

/** Answers GETs the way the routes would, and records every call (writes must never happen before a confirm). */
const runner: CapabilityRunner = {
  async call(_principal, scope, call) {
    calls.push({ scope, call });
    if (call.method === 'GET' && call.path === '/v1/teams') return { status: 200, body: [{ id: teamId, name: 'Cards desk' }] };
    if (call.method === 'GET' && call.path === `/v1/teams/${teamId}`) return { status: 200, body: { id: teamId, name: 'Cards desk', description: null } };
    if (call.method === 'PATCH' && call.path === `/v1/teams/${teamId}`) return { status: 200, body: { id: teamId, name: (call.body as { name: string }).name } };
    return { status: 404, body: { error: { category: 'not_found', code: 'not_found', message: 'nothing here' } } };
  },
};

const person = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI', sessionId: uuidv7() });
let tech: Principal;
let head: Principal;
let service: Principal;

const sink = () => {
  const out = { text: '', steps: [] as string[], links: [] as unknown[], cards: [] as ActionCard[], denied: [] as string[], threads: [] as string[] };
  const s: AgentSink = {
    text: (d) => (out.text += d),
    step: (l) => out.steps.push(l),
    links: (l) => out.links.push(...l),
    table: () => {},
    card: (c) => out.cards.push(c),
    denied: (m) => out.denied.push(m),
    thread: (id) => out.threads.push(id),
  };
  return { s, out };
};

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [(tech = person('TECH')), (head = person('HEAD')), (service = person('SERVICE'))]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.role}@x.test`, p.displayName, p.role]);
  }
  const providerId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profileId = uuidv7();
  await t.db.insert(modelProfiles).values({ id: profileId, name: 'internal-agent', providerId, model: 'scripted', retries: 0 });
  await t.db.update(deploymentSettings).set({ internalAgentProfileId: profileId }).where(eq(deploymentSettings.id, 1));
  adapter = new ScriptedAdapter(providerId);
  const gateway = new ModelGateway(t.db, { get: async () => adapter }, new UsageRecorder(t.db), new SettingsService(t.db));
  actions = new InternalActionService(t.db, runner, null);
  agent = new InternalAgentService(t.db, gateway, new AskOcsoTools(t.db, runner, actions), actions);
});
afterAll(async () => {
  await t?.drop();
});
beforeEach(() => {
  adapter.requests = [];
  calls.length = 0;
});

describe('Ask OCSO loop (PM/research/12 §4)', () => {
  it('shows the model exactly two tools, whatever the role', async () => {
    for (const p of [tech, service]) {
      adapter.script = [{ text: 'Hello.' }];
      await agent.ask(p, null, 'Hi', sink().s, 'c0');
      expect(adapter.requests.at(-1)!.tools.map((x) => x.name)).toEqual(['get_tools', 'execute_tool']);
    }
  });

  it('refuses a tool the user lacks even when the model calls it anyway, without calling the route', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'insight.latency_breakdown', args: { minutes: 60 } } }] }, { text: 'That needs the Tech admin.' }];
    const { s, out } = sink();
    await agent.ask(head, null, 'Why did latency spike?', s, 'c1');
    expect(out.denied).toEqual(['Not available for your role: latency breakdown.']);
    expect(JSON.stringify(adapter.requests[1]!.messages.at(-1))).toContain('telemetry.technical.read');
    expect(calls).toEqual([]);
  });

  it('runs a read through the runner as the user, bound to the thread and the tool call', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'users.list_teams', args: {} } }] }, { text: 'One team.' }];
    const { s, out } = sink();
    const { threadId } = await agent.ask(head, null, 'Which teams are there?', s, 'c2');
    expect(calls).toEqual([{ scope: { threadId, callId: 'call_1_0', correlationId: 'c2' }, call: { method: 'GET', path: '/v1/teams' } }]);
    expect(out.steps).toEqual(['users · list teams']);
    const result = JSON.stringify(adapter.requests[1]!.messages.at(-1));
    expect(result).toContain('Cards desk');
    expect(result).toContain('not instructions');
  });

  it('turns a write into a card: only reads happen until the user confirms', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'users.update_team', args: { id: teamId, name: 'Card disputes' } } }] }, { text: 'Confirm to rename.' }];
    const { s, out } = sink();
    const { threadId } = await agent.ask(head, null, 'Rename Cards desk to Card disputes', s, 'c3');
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]).toMatchObject({ kind: 'direct', title: 'Update team · Cards desk', changes: [{ label: 'name', before: 'Cards desk', after: 'Card disputes' }] });
    expect(calls.map((c) => c.call.method)).toEqual(['GET']);
    const history = await agent.messages(head, threadId);
    expect(JSON.stringify(history[1]!.parts)).toContain('"status":"PENDING"');
    await expect(actions.confirm(service, out.cards[0]!.id, {}, 'c4')).rejects.toMatchObject({ category: 'not_found' });
    const done = await actions.confirm(head, out.cards[0]!.id, {}, 'c5');
    expect(done.status).toBe('EXECUTED');
    expect(calls.at(-1)!.call).toEqual({ method: 'PATCH', path: `/v1/teams/${teamId}`, body: { name: 'Card disputes' } });
    expect(calls.at(-1)!.scope).toMatchObject({ threadId, cardId: out.cards[0]!.id });
    const [row] = await t.db.select().from(internalAgentActions).where(eq(internalAgentActions.id, out.cards[0]!.id));
    expect(row).toMatchObject({ status: 'EXECUTED', callId: expect.any(String), auditEventId: expect.any(String) });
  });

  it('re-checks permissions at confirmation time', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'users.update_team', args: { id: teamId, name: 'X desk' } } }] }, { text: 'ok' }];
    const { s, out } = sink();
    await agent.ask(head, null, 'Rename', s, 'c6');
    // The same user, whose rights dropped (a revoke) since the card was built.
    const demoted: Principal = { ...head, permissions: new Set() };
    await expect(actions.confirm(demoted, out.cards[0]!.id, {}, 'c7')).rejects.toMatchObject({ category: 'authorization' });
  });

  it('with writes switched off, says so in the prompt and makes no card', async () => {
    await t.db.update(deploymentSettings).set({ askOcsoWrites: false }).where(eq(deploymentSettings.id, 1));
    try {
      adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'users.update_team', args: { id: teamId, name: 'Y desk' } } }] }, { text: 'Writes are off.' }];
      const { s, out } = sink();
      await agent.ask(head, null, 'Rename', s, 'c8');
      expect(out.cards).toEqual([]);
      expect(JSON.stringify(adapter.requests[0]!.system)).toContain('writes are turned off');
      expect(JSON.stringify(adapter.requests[1]!.messages.at(-1))).toContain('turned off');
    } finally {
      await t.db.update(deploymentSettings).set({ askOcsoWrites: true }).where(eq(deploymentSettings.id, 1));
    }
  });

  it('answers read questions with insight data and persists the thread', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'execute_tool', input: { name: 'insight.attention_summary', args: {} } }] }, { text: 'Nothing urgent right now.' }];
    const { s, out } = sink();
    const { threadId } = await agent.ask(service, null, 'What needs my attention?', s, 'c9');
    expect(out.text).toBe('Nothing urgent right now.');
    const messages = await agent.messages(service, threadId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    await expect(agent.messages(head, threadId)).rejects.toMatchObject({ category: 'not_found' });
  });

  it('passes the open page to the model and keeps it on the thread', async () => {
    adapter.script = [{ text: 'Looking at it.' }];
    const conversationId = uuidv7();
    const { threadId } = await agent.ask(service, null, 'Summarise this conversation', sink().s, 'c10', undefined, { path: `/conversations/${conversationId}`, conversationId });
    expect(JSON.stringify(adapter.requests[0]!.system)).toContain(`conversation ${conversationId}`);
    const { rows } = await t.pool.query(`SELECT context FROM internal_agent_threads WHERE id = $1`, [threadId]);
    expect(rows[0].context).toEqual({ path: `/conversations/${conversationId}`, conversationId });
  });

  it('reports whether a model profile is configured', async () => {
    expect(await agent.configured()).toBe(true);
  });
});
