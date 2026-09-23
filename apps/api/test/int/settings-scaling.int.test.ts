import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScalingService } from '@ocso/application';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

type Adapter = ConstructorParameters<typeof ScalingService>[0]['adapter'];

let h: ApiHarness;
const tokens = { admin: '', lead: '' };
const as = (who: keyof typeof tokens) => ({ authorization: `Bearer ${tokens[who]}` });

/** Stands in for the worker leader: a Compose-like adapter that answers with advice. */
const adapter: Adapter = {
  driver: 'compose',
  publishesMetrics: false,
  async applyScaling(s) {
    const command = `docker compose up -d --scale worker=${s.minWarmWorkers}`;
    return {
      driver: 'compose',
      outcome: 'ADVISORY',
      message: `Worker replicas are operator-controlled: run \`${command}\`.`,
      commands: [command],
      changes: [],
      warnings: [],
      effective: { autoscaling: false, minCapacity: s.minWarmWorkers, maxCapacity: s.minWarmWorkers, targetSlotDemandPerWorker: null, queueAgeThresholdSeconds: null, scaleInCooldownSeconds: null, scaleOutCooldownSeconds: null },
    };
  },
  async describe() {
    return { driver: 'compose', checkedAt: new Date().toISOString(), replicaControl: 'operator', note: 'Compose does not report replica counts.' };
  },
  async publishMetrics() {},
  taskProtection() {
    throw new Error('not used by the API');
  },
};

beforeAll(async () => {
  h = await startApi();
  tokens.admin = await completeSetup(h);
  await h.http().post('/v1/users').set(as('admin')).send({ email: 'lead@ocso.test', name: 'Lead', role: 'HEAD', password: 'correct password 1234' }).expect(201);
  tokens.lead = await h.loginAs('lead@ocso.test', 'correct password 1234');
});
afterAll(async () => {
  await h?.close();
});

describe('worker settings reflect the deployment apply status (ADR-023)', () => {
  it('is PENDING until the worker leader has applied the settings', async () => {
    const res = await h.http().get('/v1/settings/workers').set(as('admin')).expect(200);
    expect(res.body).toMatchObject({ minWarmWorkers: 2, scaling: { status: 'PENDING', lastOutcome: null, driver: null, inSync: false } });
    const deployment = await h.http().get('/v1/settings/workers/deployment').set(as('admin')).expect(200);
    expect(deployment.body).toEqual({ driver: null, deployment: null, describedAt: null, describeError: null });
  });

  it('shows the advisory text and command once applied, and PENDING again after a change', async () => {
    const worker = new ScalingService({ db: h.db.db, adapter, queue: { reportsOldestAge: true, stats: async () => ({ depth: 0, inFlight: 0, dead: 0, oldestAgeSeconds: null }) } });
    await worker.reconcile('startup');

    const applied = await h.http().get('/v1/settings/workers').set(as('admin')).expect(200);
    expect(applied.body.scaling).toMatchObject({
      status: 'ADVISORY',
      driver: 'compose',
      inSync: true,
      advisory: 'Worker replicas are operator-controlled: run `docker compose up -d --scale worker=2`.',
      commands: ['docker compose up -d --scale worker=2'],
    });
    const deployment = await h.http().get('/v1/settings/workers/deployment').set(as('admin')).expect(200);
    expect(deployment.body).toMatchObject({ driver: 'compose', deployment: { replicaControl: 'operator' }, describeError: null });
    expect(deployment.body.describedAt).toEqual(expect.any(String));

    const patched = await h.http().patch('/v1/settings/workers').set(as('admin')).send({ minWarmWorkers: 3 }).expect(200);
    expect(patched.body).toMatchObject({ minWarmWorkers: 3, scaling: { status: 'PENDING', lastOutcome: 'ADVISORY', inSync: false } });

    await worker.reconcile('config_changed');
    const reapplied = await h.http().get('/v1/settings/workers').set(as('admin')).expect(200);
    expect(reapplied.body.scaling).toMatchObject({ status: 'ADVISORY', inSync: true, commands: ['docker compose up -d --scale worker=3'] });
  });

  it('keeps the existing permission checks (SYSTEM_READ)', async () => {
    await h.http().get('/v1/settings/workers/deployment').expect(401);
    await h.http().get('/v1/settings/workers/deployment').set(as('lead')).expect(403);
    await h.http().get('/v1/settings/workers').set(as('lead')).expect(403);
  });
});
