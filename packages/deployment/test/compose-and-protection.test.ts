import { describe, expect, it } from 'vitest';
import { ComposeDeploymentAdapter, EcsAgentTaskProtection, EcsDeploymentAdapter, protectionExpiryMinutes, type ScalingSettings } from '../src/index.js';
import { fakeAws } from './fake-aws.js';

const SETTINGS: ScalingSettings = {
  autoscalingEnabled: false,
  minWarmWorkers: 2,
  maxWorkers: 10,
  conversationsPerWorker: 10,
  targetUtilization: 0.75,
  scaleOutQueueAgeSeconds: 10,
  scaleOutQueueDepth: 20,
  scaleInCooldownSeconds: 180,
};

describe('ComposeDeploymentAdapter', () => {
  it('answers with the exact command for the warm floor and marks it advisory', async () => {
    const result = await new ComposeDeploymentAdapter().applyScaling({ ...SETTINGS, minWarmWorkers: 3 });
    expect(result).toMatchObject({ driver: 'compose', outcome: 'ADVISORY', commands: ['docker compose up -d --scale worker=3'], changes: [] });
    expect(result.message).toContain('`docker compose up -d --scale worker=3`');
    expect(result.message).toMatch(/does not enforce max workers \(10\)/);
    expect(result.warnings).toEqual([]);
  });

  it('warns that Compose cannot autoscale and never advises zero workers', async () => {
    const result = await new ComposeDeploymentAdapter({ workerService: 'agent-worker' }).applyScaling({ ...SETTINGS, autoscalingEnabled: true, minWarmWorkers: 0 });
    expect(result.commands).toEqual(['docker compose up -d --scale agent-worker=1']);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.join(' ')).toMatch(/cannot scale on its own/);
  });

  it('publishes nothing, protects nothing, describes operator control', async () => {
    const compose = new ComposeDeploymentAdapter({ now: () => new Date('2026-09-22T00:00:00Z') });
    expect(compose.publishesMetrics).toBe(false);
    await expect(compose.publishMetrics({ at: new Date(), slotDemand: 1, workers: 1, oldestQueueAgeSeconds: 0, turnsInFlight: 1, turnLatencyP95Ms: null })).resolves.toBeUndefined();
    const protection = compose.taskProtection();
    expect(protection.mode).toBe('none');
    await expect(protection.around(async () => protection.holders, { turnTimeoutSeconds: 90 })).resolves.toBe(1);
    expect(protection.holders).toBe(0);
    expect(await compose.describe()).toMatchObject({ driver: 'compose', replicaControl: 'operator', checkedAt: '2026-09-22T00:00:00.000Z' });
    expect((await compose.describe()).facts?.[0]).toEqual({ label: 'replicas', value: 'managed by the operator (docker compose)' });
  });
});

function agent(options: { failWith?: 'http' | 'throw' | 'failure' } = {}) {
  const puts: Array<{ url: string; body: { ProtectionEnabled: boolean; ExpiresInMinutes?: number } }> = [];
  let clock = 1_000_000;
  const warnings: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    puts.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (options.failWith === 'throw') throw new TypeError('fetch failed');
    if (options.failWith === 'http') return new Response('{}', { status: 500 });
    if (options.failWith === 'failure') return Response.json({ failure: { Reason: 'TASK_NOT_VALID' } });
    return Response.json({ protection: { ProtectionEnabled: true } });
  }) as typeof fetch;
  const protection = new EcsAgentTaskProtection({
    agentUri: 'http://169.254.170.2/api/abc/',
    fetch: fetchFn,
    now: () => clock,
    logger: { warn: (_o, msg) => warnings.push(msg), info: () => {} },
  });
  return { protection, puts, warnings, advance: (ms: number) => (clock += ms) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('EcsAgentTaskProtection', () => {
  it('sizes the expiry to two turns plus two minutes', () => {
    expect(protectionExpiryMinutes(90)).toBe(5);
    expect(protectionExpiryMinutes(10)).toBe(3);
    expect(protectionExpiryMinutes(900)).toBe(32);
  });

  it('enables on the first turn and disables after the last (reference-counted)', async () => {
    const { protection, puts } = agent();
    const a = deferred();
    const b = deferred();
    const turnA = protection.around(() => a.promise, { turnTimeoutSeconds: 90 });
    const turnB = protection.around(() => b.promise, { turnTimeoutSeconds: 90 });
    await protection.settled();
    expect(protection.holders).toBe(2);
    expect(puts.map((p) => p.body)).toEqual([{ ProtectionEnabled: true, ExpiresInMinutes: 5 }]);
    expect(puts[0]!.url).toBe('http://169.254.170.2/api/abc/task-protection/v1/state');

    a.resolve();
    await turnA;
    await protection.settled();
    expect(puts).toHaveLength(1);

    b.resolve();
    await turnB;
    await protection.settled();
    expect(puts.map((p) => p.body.ProtectionEnabled)).toEqual([true, false]);
    expect(protection.holders).toBe(0);
  });

  it('refreshes a long-held protection before it could lapse under a running turn', async () => {
    const { protection, puts, advance } = agent();
    const first = deferred();
    const running = protection.around(() => first.promise, { turnTimeoutSeconds: 90 });
    await protection.settled();
    advance(60_000);
    await protection.around(async () => {}, { turnTimeoutSeconds: 90 }); // 4 min left ≥ 90 s + 60 s: no refresh
    await protection.settled();
    expect(puts).toHaveLength(1);
    advance(120_000);
    const late = deferred();
    const lateTurn = protection.around(() => late.promise, { turnTimeoutSeconds: 90 }); // 2 min left < 2.5 min
    await protection.settled();
    expect(puts.map((p) => p.body.ProtectionEnabled)).toEqual([true, true]);
    first.resolve();
    late.resolve();
    await Promise.all([running, lateTurn]);
  });

  it('never lets agent failures break turns, and retries on the next turn', async () => {
    for (const failWith of ['http', 'throw', 'failure'] as const) {
      const { protection, puts, warnings } = agent({ failWith });
      // Each turn waits for the enable attempt, so the agent is really called mid-turn.
      const ok = async () => {
        await protection.settled();
        return 'reply sent';
      };
      const failing = async () => {
        await protection.settled();
        throw new Error('turn failed');
      };
      await expect(protection.around(ok, { turnTimeoutSeconds: 90 })).resolves.toBe('reply sent');
      await expect(protection.around(failing, { turnTimeoutSeconds: 90 })).rejects.toThrow('turn failed');
      await protection.settled();
      // Enable failed both times, so there was nothing to disable.
      expect(puts.map((p) => p.body.ProtectionEnabled)).toEqual([true, true]);
      expect(warnings).toEqual(['task scale-in protection update failed']);
    }
  });

  it('ECS adapter without ECS_AGENT_URI falls back to no protection', () => {
    const aws = fakeAws();
    const warnings: string[] = [];
    const a = new EcsDeploymentAdapter({ cluster: 'ocso-prod', service: 'worker', clients: aws.clients, logger: { warn: (_o, m) => warnings.push(m), info: () => {} } });
    expect(a.taskProtection().mode).toBe('none');
    expect(warnings[0]).toMatch(/ECS_AGENT_URI/);
  });
});
