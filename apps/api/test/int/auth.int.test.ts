import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completeSetup, startApi, type ApiHarness } from './harness.js';

let h: ApiHarness;
let adminToken: string;

beforeAll(async () => {
  h = await startApi();
});
afterAll(async () => {
  await h?.close();
});

describe('API authentication & RBAC', () => {
  it('reports setup required, then completes setup once', async () => {
    const status = await h.http().get('/v1/setup/status').expect(200);
    expect(status.body.setupRequired).toBe(true);
    adminToken = await completeSetup(h);
    const again = await h.http().get('/v1/setup/status').expect(200);
    expect(again.body).toMatchObject({ setupRequired: false, orgName: 'Meridian Bank' });
  });

  it('rejects unauthenticated access with a normalized error', async () => {
    const res = await h.http().get('/v1/users').expect(401);
    expect(res.body.error).toMatchObject({ category: 'authentication', code: 'unauthenticated' });
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('returns the principal with role permissions', async () => {
    const me = await h.http().get('/v1/auth/me').set('authorization', `Bearer ${adminToken}`).expect(200);
    expect(me.body.role).toBe('PLATFORM_TECH_ADMIN');
    expect(me.body.permissions).toContain('system.configure');
    expect(me.body.permissions).not.toContain('conversations.read');
  });

  it('enforces permissions per role (CS Exec cannot configure the platform)', async () => {
    const team = await h.http().post('/v1/teams').set('authorization', `Bearer ${adminToken}`).send({ name: 'Cards' });
    // Tech Admin lacks teams.manage (a CS Lead concern).
    expect(team.status).toBe(403);
    await h
      .http()
      .post('/v1/users')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ email: 'exec@ocso.test', name: 'Exec', role: 'CS_EXEC', password: 'exec password 1234' })
      .expect(201);
    const execToken = await h.loginAs('exec@ocso.test', 'exec password 1234');
    const denied = await h.http().patch('/v1/settings/workers').set('authorization', `Bearer ${execToken}`).send({ minWarmWorkers: 3 }).expect(403);
    expect(denied.body.error.category).toBe('authorization');
    await h.http().get('/v1/users').set('authorization', `Bearer ${execToken}`).expect(403);
  });

  it('validates bodies and merged worker settings', async () => {
    const bad = await h.http().patch('/v1/settings/workers').set('authorization', `Bearer ${adminToken}`).send({ minWarmWorkers: 'x' }).expect(400);
    expect(bad.body.error.category).toBe('validation');
    const conflictingBounds = await h
      .http()
      .patch('/v1/settings/workers')
      .set('authorization', `Bearer ${adminToken}`)
      .send({ minWarmWorkers: 50 })
      .expect(400);
    expect(conflictingBounds.body.error.code).toBe('invalid_worker_settings');
    const ok = await h.http().patch('/v1/settings/workers').set('authorization', `Bearer ${adminToken}`).send({ minWarmWorkers: 4 }).expect(200);
    expect(ok.body.minWarmWorkers).toBe(4);
  });

  it('logs out and invalidates the token', async () => {
    const token = await h.loginAs('admin@ocso.test', 'admin password 1234');
    await h.http().post('/v1/auth/logout').set('authorization', `Bearer ${token}`).expect(204);
    await h.http().get('/v1/auth/me').set('authorization', `Bearer ${token}`).expect(401);
  });

  it('keeps liveness independent of dependencies', async () => {
    await h.http().get('/health/live').expect(200);
    await h.http().get('/health/ready').expect(200);
  });
});
