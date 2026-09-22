import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import {
  channels,
  conversationLeases,
  customers,
  interactions,
  jobs,
  turns,
  uuidv7,
  virtualAgents,
  workerScalingState,
  workerSettings,
  workers,
} from '@ocso/db';
import { DeploymentError, type DeploymentAdapter, type ScalingApplyResult, type ScalingSample, type ScalingSettings } from '@ocso/deployment';
import { ErrorCategory } from '@ocso/domain';
import { PgQueue, type QueueStats } from '@ocso/queue';
import { ScalingService, ScalingStatusService, computeScalingSample } from '../src/scaling/index.js';

const SEC = 1000;
let t: TestDatabase;
let now: Date;
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);

async function conversation(opts: { state?: string; agentId: string; channelId: string; lastProcessedSeq?: number }) {
  const id = uuidv7();
  const customerId = uuidv7();
  await t.db.insert(customers).values({ id: customerId, displayName: 'Priya Deshmukh' });
  // Raw SQL: only the columns this test needs, independent of newer optional columns.
  await t.db.execute(sql`
    INSERT INTO conversations (id, customer_id, agent_id, channel_id, type, control_state, last_processed_seq, last_interaction_at, opened_at)
    VALUES (${id}, ${customerId}, ${opts.agentId}, ${opts.channelId}, 'SUPPORT', ${opts.state ?? 'AI_ACTIVE'}, ${opts.lastProcessedSeq ?? 0},
            ${ago(60 * SEC).toISOString()}::timestamptz, ${ago(3_600 * SEC).toISOString()}::timestamptz)`);
  return id;
}

const customerMessage = (conversationId: string, seq: number, createdAt: Date) => ({
  id: uuidv7(), conversationId, seq, actorType: 'CUSTOMER' as const, direction: 'INBOUND' as const, visibility: 'CUSTOMER' as const, correlationId: 'c', createdAt,
});

beforeAll(async () => {
  t = await createTestDatabase();
  now = new Date();
  const agentId = uuidv7();
  const channelId = uuidv7();
  await t.db.insert(virtualAgents).values({ id: agentId, name: 'Maya', slug: 'maya', conversationType: 'SUPPORT', status: 'LIVE' });
  await t.db.insert(channels).values({ id: channelId, kind: 'WEBCHAT', name: 'Web chat', status: 'ACTIVE', publicKey: 'pk-scaling' });

  // Workers: two healthy + fresh, one HEALTHY but stale (> 3 × 10 s), one LOST.
  await t.db.insert(workers).values([
    { id: 'w1', hostname: 'h1', version: 'v', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(5 * SEC) },
    { id: 'w2', hostname: 'h2', version: 'v', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(20 * SEC) },
    { id: 'w3', hostname: 'h3', version: 'v', status: 'HEALTHY', capacity: 10, heartbeatAt: ago(90 * SEC) },
    { id: 'w4', hostname: 'h4', version: 'v', status: 'LOST', capacity: 10, heartbeatAt: ago(5 * SEC) },
  ]);

  const [busyA, busyB, expired, idle, waiting, human] = [
    await conversation({ agentId, channelId }),
    await conversation({ agentId, channelId }),
    await conversation({ agentId, channelId }),
    await conversation({ agentId, channelId, lastProcessedSeq: 1 }),
    await conversation({ agentId, channelId }),
    await conversation({ agentId, channelId, state: 'HUMAN_ACTIVE' }),
  ];
  // Turns in flight = busy, unexpired leases only.
  await t.db.insert(conversationLeases).values([
    { conversationId: busyA, workerId: 'w1', leaseVersion: 1, busy: true, expiresAt: ahead(30 * SEC) },
    { conversationId: busyB, workerId: 'w2', leaseVersion: 1, busy: true, expiresAt: ahead(30 * SEC) },
    { conversationId: expired, workerId: 'w4', leaseVersion: 1, busy: true, expiresAt: ago(10 * SEC) },
    { conversationId: idle, workerId: 'w1', leaseVersion: 1, busy: false, expiresAt: ahead(300 * SEC) },
  ]);
  // Waiting (SQS age fallback): unprocessed customer messages; busy and human-controlled ones do not count.
  await t.db.insert(interactions).values([
    customerMessage(waiting, 1, ago(45 * SEC)),
    customerMessage(expired, 1, ago(20 * SEC)),
    customerMessage(busyA, 1, ago(300 * SEC)),
    customerMessage(human, 1, ago(600 * SEC)),
    customerMessage(idle, 1, ago(900 * SEC)), // already processed (seq 1 ≤ last_processed_seq 1)
  ]);
  // Queue: three ready turn wake-ups (oldest 30 s), one delayed, one running, one on another topic.
  await t.db.insert(jobs).values([
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(30 * SEC), availableAt: ago(30 * SEC) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(10 * SEC), availableAt: ago(10 * SEC) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(5 * SEC), availableAt: ago(5 * SEC) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'queued', enqueuedAt: ago(60 * SEC), availableAt: ahead(60 * SEC) },
    { id: uuidv7(), topic: 'conversation.turn', payload: {}, status: 'running', enqueuedAt: ago(8 * SEC) },
    { id: uuidv7(), topic: 'channel.deliver', payload: {}, status: 'queued', enqueuedAt: ago(500 * SEC), availableAt: ago(500 * SEC) },
  ]);
  // Latency: 10 completed turns in the last 5 min (1 s … 10 s); older and failed ones excluded.
  const turn = (completedAt: Date, latencyMs: number, status: 'COMPLETED' | 'FAILED' = 'COMPLETED') => ({
    id: uuidv7(), conversationId: busyA, workerId: 'w1', leaseVersion: 1, seqFrom: 1, seqTo: 1, status, latencyMs, startedAt: completedAt, completedAt,
  });
  await t.db.insert(turns).values([
    ...Array.from({ length: 10 }, (_, i) => turn(ago((i + 1) * 20 * SEC), (i + 1) * 1000)),
    turn(ago(400 * SEC), 99_000),
    turn(ago(30 * SEC), 88_000, 'FAILED'),
  ]);
});

afterAll(async () => {
  await t.drop();
});

describe('computeScalingSample', () => {
  it('derives the ADR-023 signals from PostgreSQL and the Postgres queue', async () => {
    const sample = await computeScalingSample(t.db, new PgQueue(t.pool, { workerId: 'w1' }), now);
    expect(sample).toMatchObject({ turnsInFlight: 2, queuedTurns: 3, slotDemand: 5, workers: 2, sources: { depth: 'queue', age: 'queue' } });
    expect(sample.oldestQueueAgeSeconds).toBeGreaterThanOrEqual(29);
    expect(sample.oldestQueueAgeSeconds).toBeLessThan(40);
    // percentile_cont(0.95) over 1000…10000 = 9550.
    expect(sample.turnLatencyP95Ms).toBe(9550);
  });

  it('SQS: depth from the queue, age from the oldest waiting customer message', async () => {
    const sqs = { driver: 'sqs' as const, stats: async (): Promise<QueueStats> => ({ depth: 4, inFlight: 1, dead: 0, oldestAgeSeconds: null }) };
    const sample = await computeScalingSample(t.db, sqs, now);
    expect(sample).toMatchObject({ queuedTurns: 4, slotDemand: 6, oldestQueueAgeSeconds: 45, sources: { depth: 'queue', age: 'postgres' } });
  });

  it('falls back to PostgreSQL entirely when queue stats fail', async () => {
    const broken = { driver: 'sqs' as const, stats: async (): Promise<QueueStats> => { throw new Error('throttled'); } };
    const sample = await computeScalingSample(t.db, broken, now);
    // Waiting conversations: `waiting` and `expired` (its busy lease has expired).
    expect(sample).toMatchObject({ queuedTurns: 2, slotDemand: 4, oldestQueueAgeSeconds: 45, sources: { depth: 'postgres', age: 'postgres' } });
  });

  it('reports no latency without recent completed turns', async () => {
    const later = new Date(now.getTime() + 3_600 * SEC);
    const sample = await computeScalingSample(t.db, new PgQueue(t.pool, { workerId: 'w1' }), later);
    expect(sample.turnLatencyP95Ms).toBeNull();
    expect(sample.workers).toBe(0);
  });
});

class FakeAdapter implements DeploymentAdapter {
  readonly driver = 'compose' as const;
  publishesMetrics = true;
  applied: ScalingSettings[] = [];
  published: ScalingSample[] = [];
  applyError: Error | null = null;
  describeError: Error | null = null;
  gate: Promise<void> | null = null;

  async applyScaling(s: ScalingSettings): Promise<ScalingApplyResult> {
    this.applied.push(s);
    if (this.gate) await this.gate;
    if (this.applyError) throw this.applyError;
    return {
      driver: 'compose', outcome: 'ADVISORY', message: `Run the warm floor of ${s.minWarmWorkers}.`, commands: [`docker compose up -d --scale worker=${s.minWarmWorkers}`], changes: [], warnings: ['w'],
      effective: { autoscaling: false, minCapacity: s.minWarmWorkers, maxCapacity: s.minWarmWorkers, targetSlotDemandPerWorker: null, queueAgeThresholdSeconds: null, scaleInCooldownSeconds: null, scaleOutCooldownSeconds: null },
    };
  }
  async describe() {
    if (this.describeError) throw this.describeError;
    return { driver: 'compose' as const, checkedAt: now.toISOString(), replicaControl: 'operator' as const, note: 'operator' };
  }
  async publishMetrics(sample: ScalingSample) {
    this.published.push(sample);
  }
  taskProtection(): never {
    throw new Error('not used');
  }
}

describe('ScalingService', () => {
  let adapter: FakeAdapter;
  let service: ScalingService;
  const read = () => new ScalingStatusService(t.db).workers();

  beforeEach(async () => {
    await t.db.delete(workerScalingState);
    adapter = new FakeAdapter();
    service = new ScalingService({ db: t.db, adapter, queue: new PgQueue(t.pool, { workerId: 'w1' }), now: () => now });
  });

  it('records an advisory outcome the API can show, then PENDING after a settings change', async () => {
    expect((await read()).status).toBe('PENDING');
    const outcome = await service.reconcile('startup');
    expect(outcome.status).toBe('ADVISORY');
    expect(adapter.applied[0]).toMatchObject({ minWarmWorkers: 2, maxWorkers: 10, conversationsPerWorker: 10, autoscalingEnabled: false });

    const view = await read();
    expect(view).toMatchObject({ status: 'ADVISORY', lastOutcome: 'ADVISORY', driver: 'compose', inSync: true, advisory: 'Run the warm floor of 2.', commands: ['docker compose up -d --scale worker=2'], warnings: ['w'] });
    expect((await new ScalingStatusService(t.db).deployment()).deployment).toMatchObject({ driver: 'compose', replicaControl: 'operator' });

    await t.db.update(workerSettings).set({ minWarmWorkers: 3, updatedAt: new Date(Date.now() + 5 * SEC) }).where(eq(workerSettings.id, 1));
    const pending = await read();
    expect(pending).toMatchObject({ status: 'PENDING', lastOutcome: 'ADVISORY', inSync: false });
    expect(pending.message).toMatch(/not been applied yet/);

    await service.reconcile('config_changed');
    expect(await read()).toMatchObject({ status: 'ADVISORY', inSync: true, commands: ['docker compose up -d --scale worker=3'] });
  });

  it('records failures with the reason and keeps the last good snapshot', async () => {
    await service.reconcile('startup');
    const good = await t.db.select().from(workerScalingState);
    adapter.applyError = new DeploymentError(ErrorCategory.POLICY_DENIED, 'deployment_aws_call_failed', 'PutScalingPolicy failed: AccessDeniedException: denied', { operation: 'PutScalingPolicy' });
    adapter.describeError = new Error('DescribeServices failed: throttled');
    const outcome = await service.reconcile('periodic');
    expect(outcome).toMatchObject({ status: 'FAILED', describeError: 'DescribeServices failed: throttled' });

    const [row] = await t.db.select().from(workerScalingState);
    expect(row).toMatchObject({ applyStatus: 'FAILED', applyDetail: { code: 'deployment_aws_call_failed', category: 'policy_denied', operation: 'PutScalingPolicy' } });
    expect(row!.lastSucceededAt).toEqual(good[0]!.lastSucceededAt);
    expect(row!.deployment).toEqual(good[0]!.deployment);
    expect(await read()).toMatchObject({ status: 'FAILED', message: 'PutScalingPolicy failed: AccessDeniedException: denied', advisory: null });
    expect(await new ScalingStatusService(t.db).deployment()).toMatchObject({ describeError: 'DescribeServices failed: throttled', driver: 'compose' });
  });

  it('serializes reconciles and coalesces requests that queue up behind a running one', async () => {
    let release!: () => void;
    adapter.gate = new Promise((r) => (release = r));
    const first = service.reconcile('startup');
    // Wait until the first reconcile is inside the adapter (a fixed sleep is flaky under load).
    await vi.waitFor(() => expect(adapter.applied).toHaveLength(1), { timeout: 5_000, interval: 5 });
    const second = service.reconcile('config_changed');
    const third = service.reconcile('periodic');
    expect(third).toBe(second);
    release();
    await Promise.all([first, second, third]);
    expect(adapter.applied).toHaveLength(2);
  });

  it('publishes a sample only when the adapter has a metrics sink', async () => {
    const sample = await service.publishMetrics();
    expect(sample).toMatchObject({ slotDemand: 5, workers: 2 });
    expect(adapter.published).toHaveLength(1);
    adapter.publishesMetrics = false;
    expect(await service.publishMetrics()).toBeNull();
    expect(adapter.published).toHaveLength(1);
  });
});
