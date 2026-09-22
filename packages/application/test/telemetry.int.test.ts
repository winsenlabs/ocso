import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  auditEvents,
  channels,
  conversationLeases,
  conversations,
  customers,
  healthSamples,
  interactions,
  jobs,
  mcpConnections,
  modelProfiles,
  modelProviders,
  toolCalls,
  tools,
  turns,
  usageEvents,
  users,
  uuidv7,
  virtualAgents,
  workers,
} from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { SystemOverviewService, recordWorkerHealthSample, serverLabel, traceUrl, uptime } from '../src/telemetry/index.js';

/** Fixed clock: every telemetry query takes `now` explicitly. */
const NOW = new Date('2026-09-22T12:00:30.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000;
const HOUR = 3_600_000;
const minuteStart = (offsetMinutes: number) => new Date(Math.floor(NOW.getTime() / MIN) * MIN - offsetMinutes * MIN);
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

const admin: Principal = { userId: '00000000-0000-7000-8000-0000000000ad', role: 'PLATFORM_TECH_ADMIN', displayName: 'T. Shetty', teamIds: [], via: 'UI' };
const exec: Principal = { userId: '00000000-0000-7000-8000-0000000000e1', role: 'CS_EXEC', displayName: 'Nikhil', teamIds: [], via: 'UI' };

let t: TestDatabase;
let service: SystemOverviewService;
const ids: Record<string, string> = {};

async function seed() {
  const db = t.db;
  await db.insert(users).values([
    { id: admin.userId, email: 'admin@x.test', name: 'T. Shetty', role: 'PLATFORM_TECH_ADMIN' },
    { id: exec.userId, email: 'exec@x.test', name: 'Nikhil', role: 'CS_EXEC' },
  ]);
  // Workers: 1 healthy, 1 HEALTHY-but-stale, 1 LOST, 1 long stopped (hidden).
  await db.insert(workers).values([
    { id: 'wkr-1', hostname: 'h1', version: 'v1', status: 'HEALTHY', capacity: 10, activeLeases: 6, cpuPercent: 40, memoryMb: 900, startedAt: ago(2 * HOUR), heartbeatAt: ago(5_000) },
    { id: 'wkr-2', hostname: 'h2', version: 'v1', status: 'HEALTHY', capacity: 10, activeLeases: 2, startedAt: ago(3 * HOUR), heartbeatAt: ago(120_000) },
    { id: 'wkr-3', hostname: 'h3', version: 'v1', status: 'LOST', capacity: 10, activeLeases: 0, startedAt: ago(5 * HOUR), heartbeatAt: ago(2 * HOUR), stoppedAt: ago(2 * HOUR) },
    { id: 'wkr-4', hostname: 'h4', version: 'v0', status: 'STOPPED', capacity: 10, startedAt: ago(90 * HOUR), heartbeatAt: ago(72 * HOUR), stoppedAt: ago(72 * HOUR) },
  ]);
  // Database samples: minutes -60..-1, minute -20 DOWN, 2-minute gap (-31,-30), 3-minute gap (-42..-40).
  const samples = [];
  for (let m = 60; m >= 1; m--) {
    if ([30, 31, 40, 41, 42].includes(m)) continue;
    samples.push({ id: uuidv7(), component: 'database', status: m === 20 ? ('DOWN' as const) : ('OK' as const), latencyMs: 3, sampledAt: new Date(minuteStart(m).getTime() + 10_000) });
  }
  await db.insert(healthSamples).values(samples);

  // Queue: three ready turn jobs (oldest 30 s), one running, one dead delivery.
  await db.insert(jobs).values([
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(30_000), availableAt: ago(30_000) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(10_000), availableAt: ago(10_000) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(5_000), availableAt: ago(5_000) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'running', enqueuedAt: ago(4_000) },
    { id: uuidv7(), topic: 'channel.deliver', payload: {}, status: 'dead', enqueuedAt: ago(HOUR) },
  ]);

  // Providers: Bedrock OK (primary), Anthropic DEGRADED (fallback), Foundry unused.
  ids.p1 = uuidv7();
  ids.p2 = uuidv7();
  ids.p3 = uuidv7();
  await db.insert(modelProviders).values([
    { id: ids.p1, kind: 'BEDROCK', name: 'AWS Bedrock', region: 'ap-south-1', residencyZone: 'IN', status: 'OK' },
    { id: ids.p2, kind: 'ANTHROPIC', name: 'Anthropic', status: 'DEGRADED' },
    { id: ids.p3, kind: 'FOUNDRY', name: 'Microsoft Foundry', status: 'UNTESTED' },
  ]);
  ids.prof1 = uuidv7();
  ids.prof2 = uuidv7();
  await db.insert(modelProfiles).values([
    { id: ids.prof1, name: 'support-primary', providerId: ids.p1, model: 'claude', fallbacks: [{ providerId: ids.p2, model: 'claude' }] },
    { id: ids.prof2, name: 'summarizer', providerId: ids.p1, model: 'haiku' },
  ]);
  const usage = (at: Date, o: Partial<typeof usageEvents.$inferInsert>) => ({ id: uuidv7(), occurredAt: at, purpose: 'TURN', status: 'OK' as const, ...o });
  await db.insert(usageEvents).values([
    ...Array.from({ length: 8 }, (_, i) =>
      usage(ago((10 + i) * MIN), { providerId: ids.p1, profileId: ids.prof1, ttftMs: (i + 1) * 100, latencyMs: (i + 1) * 1000, inputTokens: 1000, uncachedInputTokens: 200, cachedInputTokens: 800, outputTokens: 50, costMicros: 10, currency: 'USD' }),
    ),
    usage(minuteStart(5), { providerId: ids.p1, profileId: ids.prof1, status: 'ERROR', errorCategory: 'provider_rate_limited' }),
    usage(minuteStart(5), { providerId: ids.p1, profileId: ids.prof1, status: 'ERROR', errorCategory: 'provider_rate_limited' }),
    usage(minuteStart(5), { providerId: ids.p2, profileId: ids.prof1, fallbackFromProviderId: ids.p1, ttftMs: 900, latencyMs: 9000, inputTokens: 1000, outputTokens: 50, costMicros: 20, currency: 'USD' }),
    usage(minuteStart(5), { providerId: ids.p2, profileId: ids.prof1, fallbackFromProviderId: ids.p1, ttftMs: 1000, latencyMs: 9000, inputTokens: 1000, outputTokens: 50, costMicros: 20, currency: 'USD' }),
    usage(ago(20 * MIN), { purpose: 'SUMMARY', providerId: ids.p1, profileId: ids.prof2, ttftMs: 5, latencyMs: 500, inputTokens: 500, cachedInputTokens: 0, outputTokens: 100 }),
    // Yesterday: excluded from "today" and from the last hour.
    usage(ago(13 * HOUR), { providerId: ids.p1, profileId: ids.prof1, inputTokens: 99_999, outputTokens: 1 }),
  ]);

  // Conversations for turns, leases, deliveries.
  const agentId = uuidv7();
  await db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT' });
  const channelId = uuidv7();
  await db.insert(channels).values([
    { id: channelId, kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', publicKey: 'pk-tel-1' },
    { id: uuidv7(), kind: 'WHATSAPP', name: 'WhatsApp', status: 'DISABLED', publicKey: 'pk-tel-2' },
  ]);
  const conv = async (state = 'AI_ACTIVE') => {
    const id = uuidv7();
    const customerId = uuidv7();
    await db.insert(customers).values({ id: customerId, displayName: 'Priya Deshmukh' });
    await db.insert(conversations).values({ id, customerId, agentId, channelId, type: 'SUPPORT', controlState: state, lastInteractionAt: ago(2 * MIN), openedAt: ago(4 * HOUR) });
    return id;
  };
  const [a, b, c] = [await conv(), await conv('HUMAN_ACTIVE'), await conv('RESOLVED')];
  const turn = (conversationId: string, workerId: string, startedAt: Date, o: Partial<typeof turns.$inferInsert> = {}) => ({
    id: uuidv7(), conversationId, workerId, leaseVersion: 1, seqFrom: 1, seqTo: 1, status: 'COMPLETED' as const, startedAt, completedAt: startedAt, ...o,
  });
  await db.insert(turns).values([
    turn(a, 'wkr-3', ago(3 * HOUR), { latencyMs: 500 }),
    turn(a, 'wkr-1', ago(50 * MIN), { latencyMs: 1000, traceId: TRACE }),
    turn(b, 'wkr-1', ago(40 * MIN), { latencyMs: 2000 }),
    turn(b, 'wkr-1', ago(30 * MIN), { latencyMs: 3000 }),
    turn(c, 'wkr-2', ago(2 * HOUR), { latencyMs: 700 }),
    turn(c, 'wkr-1', ago(20 * MIN), { latencyMs: 4000 }),
    turn(c, 'wkr-1', ago(15 * MIN), { status: 'FAILED', latencyMs: 99_999 }),
  ]);
  await db.insert(conversationLeases).values([
    { conversationId: a, workerId: 'wkr-1', leaseVersion: 2, busy: true, expiresAt: new Date(NOW.getTime() + 30_000) },
    { conversationId: b, workerId: 'wkr-1', leaseVersion: 1, expiresAt: new Date(NOW.getTime() + 30_000) },
    { conversationId: c, workerId: 'wkr-1', leaseVersion: 1, expiresAt: ago(MIN) },
  ]);
  await db.insert(interactions).values({ id: uuidv7(), conversationId: a, seq: 1, actorType: 'AGENT', direction: 'OUTBOUND', visibility: 'CUSTOMER', correlationId: 'x', deliveryStatus: 'FAILED', createdAt: ago(3 * MIN) });

  // MCP: one degraded, one active, one personal (counted only).
  ids.crm = uuidv7();
  ids.cards = uuidv7();
  await db.insert(mcpConnections).values([
    { id: ids.crm, name: 'meridian-crm', url: 'https://mcp.meridian.internal/crm?token=hidden', authStrategy: 'OAUTH', status: 'DEGRADED', lastSyncAt: ago(HOUR) },
    { id: ids.cards, name: 'core-cards', url: 'https://mcp.meridian.internal/cards/', status: 'ACTIVE' },
    { id: uuidv7(), name: 'my-jira', url: 'https://jira.example/mcp', scope: 'USER', ownerUserId: exec.userId, status: 'ACTIVE' },
  ]);
  const tool = (connectionId: string, name: string, approved = true) => ({
    id: uuidv7(), connectionId, name, modelName: name.replace('.', '__'), inputSchema: {}, schemaHash: 'h', suggestedRisk: 'READ' as const, riskClass: 'READ' as const, approved,
  });
  const [disputes, list, unapproved] = [tool(ids.crm, 'disputes.raise_case'), tool(ids.cards, 'cards.list'), tool(ids.crm, 'crm.secret', false)];
  await db.insert(tools).values([disputes, list, unapproved]);
  const call = (toolRow: typeof disputes, status: 'SUCCEEDED' | 'FAILED', latencyMs: number, at = ago(2 * HOUR)) => ({
    id: uuidv7(), toolId: toolRow.id, toolName: toolRow.name, connectionId: toolRow.connectionId, actorType: 'AGENT' as const, actorId: 'agent', argsSanitized: {}, argsHash: 'h', status, latencyMs, requestedAt: at,
  });
  await db.insert(toolCalls).values([
    ...Array.from({ length: 10 }, (_, i) => call(disputes, i < 3 ? 'FAILED' : 'SUCCEEDED', (i + 1) * 100)),
    ...Array.from({ length: 20 }, (_, i) => call(list, i === 0 ? 'FAILED' : 'SUCCEEDED', 50)),
    { ...call(disputes, 'FAILED', 10, ago(30 * HOUR)), toolName: 'rare.tool', toolId: null },
  ]);

  await db.insert(auditEvents).values([
    { id: uuidv7(), occurredAt: ago(3 * HOUR), actorType: 'USER', actorId: admin.userId, actorName: 'T. Shetty', via: 'UI', action: 'workers.config_update', targetType: 'worker_settings', summary: 'Max workers 8 → 10' },
    { id: uuidv7(), occurredAt: ago(2 * HOUR), actorType: 'USER', actorId: exec.userId, actorName: 'Nikhil', via: 'UI', action: 'conversation.claim', targetType: 'conversation', targetId: a, summary: 'claimed by Nikhil (Priya Deshmukh)' },
    { id: uuidv7(), occurredAt: ago(HOUR), actorType: 'USER', actorId: admin.userId, actorName: 'T. Shetty', via: 'API', action: 'model_provider.test', targetType: 'model_provider', summary: 'tested' },
    { id: uuidv7(), occurredAt: ago(30 * MIN), actorType: 'USER', actorId: admin.userId, actorName: 'T. Shetty', via: 'INTERNAL_AGENT', action: 'mcp.connection.create', targetType: 'mcp_connection', targetId: ids.crm, summary: 'Created meridian-crm' },
  ]);
}

beforeAll(async () => {
  t = await createTestDatabase();
  await seed();
  service = new SystemOverviewService(t.db, { traceUrlTemplate: 'http://localhost:16686/trace/{traceId}', apiVersion: '2026.09.22' }, () => NOW);
});
afterAll(async () => {
  await t?.drop();
});

describe('uptime', () => {
  it('counts per-minute availability from database samples with jitter tolerance', async () => {
    const u = await uptime(t.db, NOW);
    // 60 minutes evaluated; down: -20 (DOWN sample) and -41 (middle of a 3-minute gap).
    expect(u).toMatchObject({ minutes: 60, upMinutes: 58, workerSamplesAvailable: false });
    expect(u.ratio).toBeCloseTo(58 / 60, 6);
    expect(u.lastIncidentAt).toBe(minuteStart(20).toISOString());
  });

  it("applies 'workers' samples from their first sample on", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ id: uuidv7(), component: 'workers', status: i === 7 ? ('DOWN' as const) : ('OK' as const), sampledAt: new Date(minuteStart(10 - i).getTime() + 20_000) }));
    await t.db.insert(healthSamples).values(rows);
    const u = await uptime(t.db, NOW);
    expect(u).toMatchObject({ minutes: 60, upMinutes: 57, workerSamplesAvailable: true });
    expect(u.lastIncidentAt).toBe(minuteStart(3).toISOString());
  });

  it('writes a workers sample from the live fleet', async () => {
    expect(await recordWorkerHealthSample(t.db, NOW)).toBe('DEGRADED'); // 1 healthy < min 2
  });
});

describe('system overview', () => {
  it('derives the status bar and chips from explicit rules', async () => {
    const o = await service.overview(admin);
    const chip = (key: string) => o.status.chips.find((c) => c.key === key)!;
    expect(chip('api')).toMatchObject({ status: 'ok', detail: 'serving · 2026.09.22' });
    expect(chip('runtime')).toMatchObject({ status: 'degraded', detail: '1 healthy · min 2 · max 10' });
    expect(chip('database').status).toBe('ok');
    expect(chip('queue')).toMatchObject({ status: 'degraded', detail: 'depth 3 · oldest 30s · dead 1' });
    expect(chip('providers').status).toBe('degraded');
    expect(chip('mcp')).toMatchObject({ status: 'degraded', detail: '1 of 2 degraded' });
    expect(chip('channels')).toMatchObject({ status: 'degraded', detail: '1 active · 1 inactive · 1 failed deliveries 1h' });
    expect(chip('webhooks').status).toBe('unknown');
    expect(o.status.overall).toBe('degraded');
    expect(o.status.headline).toMatch(/^Degraded — /);
    for (const c of o.status.chips) expect(c.rule.length).toBeGreaterThan(5);
  });

  it('computes tiles with documented formulas', async () => {
    const { tiles, queue } = await service.overview(admin);
    expect(tiles.activeConversations).toBe(2);
    expect(tiles.healthyWorkers).toEqual({ healthy: 1, max: 10, minWarm: 2 });
    expect(queue.source).toBe('jobs_table');
    expect(tiles.queue).toEqual({ depth: 3, oldestAgeSeconds: 30, turnDepth: 3, turnOldestAgeSeconds: 30 });
    // Completed turns started in the last hour: 1000, 2000, 3000, 4000 → p95 = 3000 + 0.85 × 1000.
    expect(tiles.turnLatencyP95Ms).toBe(3850);
    // TURN+OK TTFT: 100..800, 900, 1000 → p95 position 8.55 → 900 + 0.55 × 100.
    expect(tiles.ttftP95Ms).toBe(955);
    expect(tiles.requestsPerMinute).toBe(Math.round((13 / 60) * 10) / 10);
    expect(tiles.providerErrorRate).toBeCloseTo(2 / 13, 6);
    expect(tiles.tokensToday).toBe(10_500 + 600);
    expect(tiles.cachedInputShareToday).toBeCloseTo(6400 / 8500, 6);
    expect(tiles.worstToolFailure).toMatchObject({ toolName: 'disputes.raise_case', connectionName: 'meridian-crm', finished: 10, failed: 3, failureRate: 0.3 });
    expect(tiles.definitions['ttftP95Ms']).toContain('p95');
  });

  it('uses the queue adapter stats when provided', async () => {
    const withAdapter = new SystemOverviewService(t.db, { queueStats: async (topic) => ({ depth: topic === 'conversation.turn' ? 42 : 0, inFlight: 0, dead: 0, oldestAgeSeconds: topic === 'conversation.turn' ? 3 : null }) }, () => NOW);
    const { queue, status } = await withAdapter.overview(admin);
    expect(queue).toMatchObject({ source: 'adapter', depth: 42, oldestAgeSeconds: 3 });
    expect(status.chips.find((c) => c.key === 'queue')!.status).toBe('degraded'); // depth 42 > scale-out depth 20
  });

  it('refuses principals without technical telemetry permission', async () => {
    await expect(service.overview(exec)).rejects.toMatchObject({ category: 'authorization' });
    await expect(service.workers(exec)).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('latency, usage, workers, providers, mcp, changes', () => {
  it('returns a per-minute latency series with incident markers and trace links', async () => {
    const s = await service.latency(admin, 60);
    expect(s.points).toHaveLength(60);
    expect(s.points.at(-1)!.minute).toBe(minuteStart(0).toISOString());
    const incident = s.points.find((p) => p.minute === minuteStart(5).toISOString())!;
    expect(incident).toMatchObject({ requests: 4, errors: 2, fallbacks: 2 });
    expect(s.markers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'fallback', providerId: ids.p1, providerName: 'AWS Bedrock', count: 2 }),
        expect.objectContaining({ kind: 'provider_errors', providerId: ids.p1, count: 2, errorCategory: 'provider_rate_limited' }),
      ]),
    );
    expect(s.slowestTurns[0]).toMatchObject({ latencyMs: 4000 });
    expect(s.slowestTurns.find((x) => x.traceId === TRACE)!.traceUrl).toBe(`http://localhost:16686/trace/${TRACE}`);
  });

  it('reports token and cache usage today by profile', async () => {
    const u = await service.usage(admin);
    expect(u.totals).toMatchObject({ requests: 13, inputTokens: 10_500, outputTokens: 600, cacheReadTokens: 6400, costMicros: 120, currency: 'USD' });
    const primary = u.byProfile.find((p) => p.profileName === 'support-primary')!;
    expect(primary.tokenShare).toBeCloseTo(10_500 / 11_100, 6);
    expect(u.byProfile[0]!.profileName).toBe('support-primary');
  });

  it('lists workers with utilization, stale detection and lease accounting', async () => {
    const w = await service.workers(admin);
    expect(w.workers.map((x) => x.id)).toEqual(['wkr-1', 'wkr-2', 'wkr-3']);
    expect(w.workers[0]).toMatchObject({ effectiveStatus: 'HEALTHY', utilization: 0.6, heartbeatAgeSeconds: 5 });
    expect(w.workers[1]!.effectiveStatus).toBe('STALE');
    expect(w.leases).toMatchObject({ active: 2, busy: 1, slotsTotal: 10, recoveredToday: 1 });
    expect(w.config.lastChange).toMatchObject({ actorName: 'T. Shetty', summary: 'Max workers 8 → 10' });
  });

  it('builds provider health cards from usage and profiles', async () => {
    const { providers } = await service.providers(admin);
    const bedrock = providers.find((p) => p.providerId === ids.p1)!;
    expect(bedrock).toMatchObject({ requests1h: 11, fallbacksFrom1h: 2, tokensToday: 9000, cacheSupport: 'REPORTED', region: 'ap-south-1' });
    expect(bedrock.errorRate).toBeCloseTo(2 / 11, 6);
    expect(bedrock.p95LatencyMs).toBe(7600); // OK latencies 500, 1000..8000
    expect(bedrock.profiles.map((p) => `${p.name}:${p.role}`).sort()).toEqual(['summarizer:PRIMARY', 'support-primary:PRIMARY']);
    const anthropic = providers.find((p) => p.providerId === ids.p2)!;
    expect(anthropic).toMatchObject({ cacheSupport: 'NOT_REPORTED', profiles: [expect.objectContaining({ name: 'support-primary', role: 'FALLBACK' })] });
    expect(providers.find((p) => p.providerId === ids.p3)).toMatchObject({ cacheSupport: 'NO_TRAFFIC', profiles: [] });
  });

  it('lists MCP connection health without credentials', async () => {
    const m = await service.mcp(admin);
    expect(m.personalConnections).toBe(1);
    const crm = m.connections.find((c) => c.connectionId === ids.crm)!;
    expect(crm).toMatchObject({ server: 'mcp.meridian.internal/crm', tools: 1, toolsDiscovered: 2, calls24h: 10, status: 'DEGRADED', authStrategy: 'OAUTH' });
    expect(crm.failureRate24h).toBeCloseTo(0.3, 6);
    expect(crm.p95LatencyMs).toBe(955);
    expect(JSON.stringify(m)).not.toContain('hidden');
    expect(serverLabel('https://mcp.meridian.internal/cards/')).toBe('mcp.meridian.internal/cards');
  });

  it('lists platform privileged changes only', async () => {
    const { changes } = await service.changes(admin, 10);
    expect(changes.map((c) => c.action)).toEqual(['mcp.connection.create', 'workers.config_update']);
    expect(changes[0]).toMatchObject({ via: 'INTERNAL_AGENT', actorName: 'T. Shetty' });
    expect(JSON.stringify(changes)).not.toContain('Priya');
  });

  it('builds trace links only for well-formed trace ids', () => {
    expect(traceUrl('http://j/trace/{traceId}', TRACE)).toBe(`http://j/trace/${TRACE}`);
    expect(traceUrl('http://j/trace/{traceId}', '../../etc')).toBeNull();
    expect(traceUrl(null, TRACE)).toBeNull();
  });
});
