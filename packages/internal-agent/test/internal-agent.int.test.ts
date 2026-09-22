import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { deploymentSettings, internalAgentActions, modelProfiles, modelProviders, uuidv7, workerSettings } from '@ocso/db';
import { SettingsService } from '@ocso/application';
import { ModelGateway, UsageRecorder } from '@ocso/agent-runtime';
import { ScriptedAdapter } from '@ocso/agent-runtime/testing';
import type { Principal } from '@ocso/auth';
import { InternalActionService, InternalAgentService, InternalToolRegistry, type AgentSink } from '../src/index.js';

let t: TestDatabase;
let adapter: ScriptedAdapter;
let agent: InternalAgentService;
let actions: InternalActionService;
const registry = new InternalToolRegistry();
const person = (role: Principal['role']): Principal => ({ userId: uuidv7(), role, displayName: role, teamIds: [], via: 'UI' });
let admin: Principal;
let lead: Principal;
let exec: Principal;

const sink = () => {
  const out = { text: '', steps: [] as string[], links: [] as unknown[], actions: [] as Array<{ id: string }>, denied: [] as string[] };
  const s: AgentSink = {
    text: (d) => (out.text += d),
    step: (l) => out.steps.push(l),
    links: (l) => out.links.push(...l),
    table: () => {},
    action: (a) => out.actions.push(a),
    denied: (m) => out.denied.push(m),
  };
  return { s, out };
};

beforeAll(async () => {
  t = await createTestDatabase();
  for (const p of [(admin = person('PLATFORM_TECH_ADMIN')), (lead = person('CS_LEAD')), (exec = person('CS_EXEC'))]) {
    await t.pool.query(`INSERT INTO users (id, email, name, role) VALUES ($1, $2, $3, $4)`, [p.userId, `${p.role}@x.test`, p.displayName, p.role]);
  }
  const providerId = uuidv7();
  await t.db.insert(modelProviders).values({ id: providerId, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  const profileId = uuidv7();
  await t.db.insert(modelProfiles).values({ id: profileId, name: 'internal-agent', providerId, model: 'scripted', retries: 0 });
  await t.db.update(deploymentSettings).set({ internalAgentProfileId: profileId }).where(eq(deploymentSettings.id, 1));
  adapter = new ScriptedAdapter(providerId);
  const gateway = new ModelGateway(t.db, { get: async () => adapter }, new UsageRecorder(t.db), new SettingsService(t.db));
  actions = new InternalActionService(t.db, registry);
  agent = new InternalAgentService(t.db, gateway, registry, actions);
});
afterAll(async () => {
  await t?.drop();
});
beforeEach(() => {
  adapter.requests = [];
});

describe('internal OCSO agent permissions (docs/12 §3)', () => {
  it('offers each role only the tools its permissions allow', () => {
    const names = (p: Principal) => registry.specs(p).map((s) => s.name);
    expect(names(exec)).toContain('list_conversations');
    expect(names(exec)).not.toContain('worker_capacity');
    expect(names(exec)).not.toContain('update_worker_settings');
    expect(names(exec)).not.toContain('latency_breakdown');
    expect(names(lead)).toContain('agent_performance');
    expect(names(lead)).not.toContain('latency_breakdown');
    expect(names(lead)).not.toContain('prompt_cache_stats');
    expect(names(admin)).toContain('latency_breakdown');
    expect(names(admin)).not.toContain('list_conversations');
  });

  it('refuses a tool the user lacks even when the model calls it anyway', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'latency_breakdown', input: { minutes: 60 } }] }, { text: 'That needs the Platform Tech Admin.' }];
    const { s, out } = sink();
    await agent.ask(lead, null, 'Why did latency spike?', s, 'c1');
    expect(out.denied).toHaveLength(1);
    expect(JSON.stringify(adapter.requests[1]!.messages.at(-1))).toContain('Not permitted');
  });

  it('never executes a high-risk write without explicit confirmation, then audits it', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'update_worker_settings', input: { minWarmWorkers: 4 } }] }, { text: 'Confirm to apply.' }];
    const { s, out } = sink();
    await agent.ask(admin, null, 'Increase minimum warm workers from 2 to 4', s, 'c2');
    expect(out.actions).toHaveLength(1);
    const [before] = await t.db.select().from(workerSettings);
    expect(before!.minWarmWorkers).toBe(2);

    await expect(actions.confirm(exec, out.actions[0]!.id, 'c3')).rejects.toMatchObject({ category: 'not_found' });
    await actions.confirm(admin, out.actions[0]!.id, 'c4');
    const [after] = await t.db.select().from(workerSettings);
    expect(after!.minWarmWorkers).toBe(4);
    const { rows } = await t.pool.query(`SELECT action, via, actor_id FROM audit_events WHERE action IN ('workers.config_update', 'internal_agent.action_confirmed') ORDER BY occurred_at`);
    expect(rows).toEqual([
      { action: 'workers.config_update', via: 'INTERNAL_AGENT', actor_id: admin.userId },
      { action: 'internal_agent.action_confirmed', via: 'INTERNAL_AGENT', actor_id: admin.userId },
    ]);
    await expect(actions.confirm(admin, out.actions[0]!.id, 'c5')).rejects.toMatchObject({ code: 'action_not_pending' });
  });

  it('re-checks permissions at confirmation time', async () => {
    const id = uuidv7();
    const threadId = uuidv7();
    await t.pool.query(`INSERT INTO internal_agent_threads (id, user_id) VALUES ($1, $2)`, [threadId, exec.userId]);
    await t.db.insert(internalAgentActions).values({ id, threadId, userId: exec.userId, tool: 'update_worker_settings', params: { maxWorkers: 100 }, risk: 'HIGH_WRITE', description: 'forged', expiresAt: new Date(Date.now() + 60_000) });
    await expect(actions.confirm(exec, id, 'c6')).rejects.toMatchObject({ category: 'authorization' });
  });

  it('answers read questions with tool data and persists the thread', async () => {
    adapter.script = [{ toolCalls: [{ toolName: 'attention_summary', input: {} }] }, { text: 'Nothing urgent right now.' }];
    const { s, out } = sink();
    const { threadId } = await agent.ask(exec, null, 'What needs my attention?', s, 'c7');
    expect(out.text).toBe('Nothing urgent right now.');
    const messages = await agent.messages(exec, threadId);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    await expect(agent.messages(lead, threadId)).rejects.toMatchObject({ category: 'not_found' });
  });
});
