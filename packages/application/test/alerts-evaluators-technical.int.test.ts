import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  alertRules,
  alerts,
  conversations,
  customers,
  healthSamples,
  jobs,
  loginAttempts,
  mcpConnections,
  modelProfiles,
  modelProviders,
  turns,
  usageEvents,
  uuidv7,
  virtualAgents,
  workers,
} from '@ocso/db';
import { MemoryQueue } from '@ocso/queue';
import { AlertEngine, type AlertRuleRow } from '../src/index.js';

let t: TestDatabase;
let engine: AlertEngine;
const NOW = new Date();
const ago = (seconds: number) => new Date(NOW.getTime() - seconds * 1000);

beforeAll(async () => {
  t = await createTestDatabase();
  engine = new AlertEngine({ db: t.db, queue: new MemoryQueue() });
});
afterAll(async () => {
  await t?.drop();
});

async function rule(condition: string, params: Record<string, unknown> = {}, extra: Partial<AlertRuleRow> = {}): Promise<AlertRuleRow> {
  const [row] = await t.db
    .insert(alertRules)
    .values({ id: uuidv7(), name: condition, kind: 'TECHNICAL', condition, params, audienceRoles: ['PLATFORM_TECH_ADMIN'], windowSeconds: 300, ...extra })
    .returning();
  return row!;
}

async function run(r: AlertRuleRow, at: Date = NOW, e: AlertEngine = engine) {
  const summary = await e.evaluate(at, { ruleIds: [r.id] });
  expect(summary.failed).toEqual([]);
  const rows = await t.db.select().from(alerts).where(eq(alerts.ruleId, r.id));
  return { summary, open: rows.filter((a) => a.status !== 'RESOLVED'), all: rows };
}

async function agent(name: string): Promise<string> {
  const id = uuidv7();
  await t.db.insert(virtualAgents).values({ id, name, slug: `${name.toLowerCase()}-${id.slice(-6)}`, conversationType: 'SUPPORT' });
  return id;
}

async function conversation(agentId: string, openedAt: Date = ago(600)): Promise<string> {
  const customerId = uuidv7();
  const id = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: 'Customer' });
  await t.db.insert(conversations).values({ id, customerId, agentId, type: 'SUPPORT', openedAt });
  return id;
}

async function provider(name: string): Promise<string> {
  const id = uuidv7();
  await t.db.insert(modelProviders).values({ id, kind: 'ANTHROPIC', name });
  return id;
}

const usage = (o: Partial<typeof usageEvents.$inferInsert>) => ({ id: uuidv7(), purpose: 'turn', status: 'OK' as const, occurredAt: ago(60), ...o });

describe('technical evaluators', () => {
  it('workers_below_min: counts HEALTHY workers with a fresh heartbeat against worker_settings', async () => {
    await t.db.insert(workers).values([
      { id: 'w-fresh', hostname: 'h1', version: '1', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(5) },
      { id: 'w-stale', hostname: 'h2', version: '1', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(90) },
      { id: 'w-starting', hostname: 'h3', version: '1', status: 'STARTING', capacity: 10, heartbeatAt: ago(1) },
    ]);
    const r = await rule('workers_below_min');
    const first = await run(r);
    expect(first.open).toHaveLength(1);
    expect(first.open[0]).toMatchObject({ title: 'Healthy workers below minimum', value: '1 of 2', source: 'Workers', severity: 'WARNING' });
    expect(first.open[0]!.context).toMatchObject({ healthy: 1, minimum: 2, condition: 'workers_below_min' });
    expect(String(first.open[0]!.context['method'])).toContain('heartbeat');

    await t.db.insert(workers).values({ id: 'w-fresh-2', hostname: 'h4', version: '1', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(3) });
    const second = await run(r);
    expect(second.open).toHaveLength(0);
    expect(second.all[0]).toMatchObject({ status: 'RESOLVED', resolution: 'Auto-resolved: condition no longer met' });
  });

  it('queue_age_above: oldest ready job from the jobs table; SQS mode uses driver stats', async () => {
    await t.db.insert(jobs).values([
      { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(45), availableAt: ago(45) },
      { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(500), availableAt: new Date(NOW.getTime() + 60_000) },
      { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'running', enqueuedAt: ago(900), availableAt: ago(900) },
    ]);
    const r = await rule('queue_age_above', { topic: 'conversation.turn', thresholdSeconds: 30 });
    const { open } = await run(r);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Queue age above 30.0s · conversation.turn', value: '45.0s', source: 'Queue · conversation.turn' });
    expect(open[0]!.context).toMatchObject({ depth: 1, driver: 'postgres' });

    const sqs = await rule('queue_age_above', { topic: 'channel.deliver', thresholdSeconds: 10 });
    const sqsEngine = new AlertEngine({ db: t.db, queue: new MemoryQueue(), queueStats: async () => ({ depth: 7, inFlight: 0, dead: 0, oldestAgeSeconds: 12 }) });
    const viaStats = await run(sqs, NOW, sqsEngine);
    expect(viaStats.open[0]).toMatchObject({ value: '12.0s' });
    expect(viaStats.open[0]!.context).toMatchObject({ depth: 7, driver: 'stats' });
  });

  it('provider_error_rate_above: per-provider error ratio with a minimum request count', async () => {
    const bedrock = await provider('AWS Bedrock');
    const sarvam = await provider('Sarvam');
    await t.db.insert(usageEvents).values([
      ...Array.from({ length: 17 }, () => usage({ providerId: bedrock })),
      ...Array.from({ length: 3 }, () => usage({ providerId: bedrock, status: 'ERROR', errorCategory: 'provider_rate_limited' })),
      usage({ providerId: bedrock, status: 'ERROR', occurredAt: ago(3600) }),
      ...Array.from({ length: 5 }, () => usage({ providerId: sarvam, status: 'ERROR' })),
    ]);
    const r = await rule('provider_error_rate_above', { thresholdPercent: 5, minRequests: 20 });
    const { open } = await run(r);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Provider error rate above 5.0% · AWS Bedrock', value: '15.0%', source: 'Provider · AWS Bedrock' });
    expect(open[0]!.context).toMatchObject({ providerId: bedrock, total: 20, errors: 3, errorCategories: { provider_rate_limited: 3 } });
  });

  it('latency_p95_above: p95 of completed turns, optionally for one agent', async () => {
    const maya = await agent('Maya');
    const arjun = await agent('Arjun');
    const conv = await conversation(maya);
    await t.db.insert(turns).values(
      Array.from({ length: 10 }, (_, i) => ({
        id: uuidv7(),
        conversationId: conv,
        status: 'COMPLETED' as const,
        workerId: 'w',
        leaseVersion: 1,
        seqFrom: i,
        seqTo: i,
        latencyMs: 9000 + i * 100,
        completedAt: ago(30),
      })),
    );
    const mayaRule = await rule('latency_p95_above', { thresholdMs: 8000, minTurns: 10 }, { agentId: maya });
    const arjunRule = await rule('latency_p95_above', { thresholdMs: 8000, minTurns: 10 }, { agentId: arjun });
    const { open } = await run(mayaRule);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'Turn latency p95 above 8.0s · Maya', source: 'Agent · Maya' });
    expect(open[0]!.value).toMatch(/^p95 9\.\ds$/);
    expect(open[0]!.context).toMatchObject({ agentId: maya, turns: 10 });
    expect((await run(arjunRule)).open).toHaveLength(0);
  });

  it('ttft_p95_above: per model profile from usage_events', async () => {
    const prov = await provider('Anthropic');
    const profileId = uuidv7();
    await t.db.insert(modelProfiles).values({ id: profileId, name: 'support-primary', providerId: prov, model: 'claude' });
    await t.db.insert(usageEvents).values([
      ...Array.from({ length: 10 }, () => usage({ profileId, ttftMs: 3500 })),
      ...Array.from({ length: 10 }, () => usage({ ttftMs: 400 })),
    ]);
    const { open } = await run(await rule('ttft_p95_above', { thresholdMs: 3000, minRequests: 10 }));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ title: 'TTFT p95 above 3.0s · support-primary', value: 'p95 3.5s', source: 'Model profile · support-primary' });
  });

  it('mcp_unhealthy: shared connections in DOWN/DEGRADED/AUTH_REQUIRED, resolving when healthy again', async () => {
    const down = uuidv7();
    await t.db.insert(mcpConnections).values([
      { id: down, name: 'meridian-crm', url: 'https://crm.test/mcp', status: 'DOWN' },
      { id: uuidv7(), name: 'kb', url: 'https://kb.test/mcp', status: 'ACTIVE' },
      { id: uuidv7(), name: 'personal-gmail', url: 'https://g.test/mcp', status: 'AUTH_REQUIRED', scope: 'USER' },
    ]);
    const r = await rule('mcp_unhealthy');
    const first = await run(r);
    expect(first.open).toHaveLength(1);
    expect(first.open[0]).toMatchObject({ title: 'MCP connection unhealthy · meridian-crm', value: 'down', source: 'MCP · meridian-crm' });
    await t.db.update(mcpConnections).set({ status: 'ACTIVE' }).where(eq(mcpConnections.id, down));
    expect((await run(r)).open).toHaveLength(0);
  });

  it('token_spike and cost_spike: window total vs trailing baseline average', async () => {
    const spikeAgent = await agent('Spiky');
    const rows = [
      // Baseline: 4 previous 5-minute windows, 1,000 tokens / 0.10 USD each.
      ...[1, 2, 3, 4].map((w) => usage({ agentId: spikeAgent, inputTokens: 600, outputTokens: 400, costMicros: 100_000, occurredAt: ago(300 * w + 60) })),
      // Current window: 12,000 tokens / 1.50 USD.
      usage({ agentId: spikeAgent, inputTokens: 8000, outputTokens: 4000, costMicros: 1_500_000, occurredAt: ago(30) }),
    ];
    await t.db.insert(usageEvents).values(rows);
    const tokens = await run(await rule('token_spike', { ratio: 3, baselineWindows: 4, minValue: 5000 }, { agentId: spikeAgent }));
    expect(tokens.open).toHaveLength(1);
    expect(tokens.open[0]).toMatchObject({ title: 'Token usage spike · Spiky', value: '12.0× baseline' });
    expect(tokens.open[0]!.context).toMatchObject({ current: 12_000, baselineAverage: 1000, observedRatio: 12 });

    const cost = await run(await rule('cost_spike', { ratio: 3, baselineWindows: 4, minValue: 1_000_000 }, { agentId: spikeAgent }));
    expect(cost.open[0]).toMatchObject({ title: 'Model cost spike · Spiky', value: '15.0× baseline' });

    const floor = await run(await rule('cost_spike', { ratio: 3, baselineWindows: 4, minValue: 5_000_000 }, { agentId: spikeAgent }));
    expect(floor.open).toHaveLength(0);
  });

  it('auth_failures_above: failed sign-ins in the window, recording only distinct counts', async () => {
    await t.db.insert(loginAttempts).values([
      ...Array.from({ length: 5 }, (_, i) => ({ id: uuidv7(), email: `user${i % 2}@x.test`, ip: '10.0.0.1', success: false, occurredAt: ago(60) })),
      { id: uuidv7(), email: 'ok@x.test', success: true, occurredAt: ago(60) },
      { id: uuidv7(), email: 'old@x.test', success: false, occurredAt: ago(4000) },
    ]);
    const { open } = await run(await rule('auth_failures_above', { threshold: 3 }));
    expect(open[0]).toMatchObject({ title: 'Sign-in failures above 3', value: '5', source: 'Authentication' });
    expect(open[0]!.context).toMatchObject({ failures: 5, distinctAccounts: 2, distinctIps: 1 });
    expect(JSON.stringify(open[0])).not.toContain('user0@x.test');
  });

  it('database_degraded: latest health sample status or p95 round-trip latency', async () => {
    await t.db.insert(healthSamples).values([
      { id: uuidv7(), component: 'database', status: 'OK', latencyMs: 4, sampledAt: ago(120) },
      { id: uuidv7(), component: 'database', status: 'DEGRADED', latencyMs: 40, sampledAt: ago(10) },
      { id: uuidv7(), component: 'replica', status: 'OK', latencyMs: 900, sampledAt: ago(10) },
      { id: uuidv7(), component: 'cache', status: 'OK', latencyMs: 3, sampledAt: ago(10) },
    ]);
    expect((await run(await rule('database_degraded'))).open[0]).toMatchObject({ title: 'Database degraded · database', value: 'degraded' });
    expect((await run(await rule('database_degraded', { component: 'replica', latencyThresholdMs: 250 }))).open[0]).toMatchObject({ value: 'p95 900ms' });
    expect((await run(await rule('database_degraded', { component: 'cache' }))).open).toHaveLength(0);
  });
});
