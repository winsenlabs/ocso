import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import type { Principal } from '@ocso/auth';
import {
  SessionService,
  SettingsService,
  SetupService,
  TeamService,
  UserService,
  type ActorContext,
} from '../src/index.js';

let t: TestDatabase;
const TOKEN = 'setup-token-0123456789';
const ctx = (principal: Principal | null): ActorContext => ({ principal, correlationId: 'test' });

beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

describe('first-run setup', () => {
  it('requires the one-time token and only succeeds once', async () => {
    const setup = new SetupService(t.db, TOKEN);
    expect(await setup.isSetupRequired()).toBe(true);
    const input = {
      setupToken: TOKEN,
      orgName: 'Meridian Bank',
      adminName: 'Tejas Shetty',
      adminEmail: 'tejas@meridian.test',
      adminPassword: 'correct horse battery staple',
      timezone: 'Asia/Kolkata',
    };
    await expect(setup.complete({ ...input, setupToken: 'wrong-token-000000000' }, 'c')).rejects.toMatchObject({
      code: 'invalid_setup_token',
    });
    await setup.complete(input, 'c');
    expect(await setup.isSetupRequired()).toBe(false);
    await expect(setup.complete(input, 'c')).rejects.toMatchObject({ code: 'setup_already_completed' });
    const settings = await new SettingsService(t.db).deployment();
    expect(settings.orgName).toBe('Meridian Bank');
  });
});

describe('sessions and user management', () => {
  let admin: Principal;
  const sessionsSvc = () => new SessionService(t.db, { idleMinutes: 60, absoluteHours: 1, maxFailures: 3, failureWindowMinutes: 15 });

  beforeAll(async () => {
    const s = await sessionsSvc().login('TEJAS@meridian.test', 'correct horse battery staple', { correlationId: 'c' });
    admin = s.principal;
  });

  it('logs in case-insensitively and authenticates the bearer token', async () => {
    const s = await sessionsSvc().login('tejas@meridian.test', 'correct horse battery staple', { correlationId: 'c' });
    expect(s.principal.role).toBe('PLATFORM_TECH_ADMIN');
    const p = await sessionsSvc().authenticate(s.token);
    expect(p?.userId).toBe(s.principal.userId);
    await sessionsSvc().logout(s.token, ctx(p));
    expect(await sessionsSvc().authenticate(s.token)).toBeNull();
  });

  it('throttles repeated failures', async () => {
    const svc = sessionsSvc();
    for (let i = 0; i < 3; i++) {
      await expect(svc.login('nobody@x.test', 'wrong password 123', { correlationId: 'c' })).rejects.toMatchObject({
        code: 'invalid_credentials',
      });
    }
    await expect(svc.login('nobody@x.test', 'wrong password 123', { correlationId: 'c' })).rejects.toMatchObject({
      code: 'too_many_attempts',
    });
  });

  it('throttles an address spraying many accounts, but only when the address is verified', async () => {
    const svc = sessionsSvc();
    const spray = (i: number, ipVerified: boolean) => svc.login(`victim${i}@x.test`, 'wrong password 123', { ip: '203.0.113.7', ipVerified, correlationId: 'c' });
    // 3 × 5 failures across different accounts from one verified address.
    for (let i = 0; i < 15; i++) await expect(spray(i, true)).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(svc.login('tejas@meridian.test', 'correct horse battery staple', { ip: '203.0.113.7', ipVerified: true, correlationId: 'c' })).rejects.toMatchObject({ code: 'too_many_attempts' });
    // An unverified address (e.g. the web tier's own) never trips the per-address limit.
    await expect(svc.login('tejas@meridian.test', 'correct horse battery staple', { ip: '203.0.113.7', correlationId: 'c' })).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('lets a CS Lead manage only CS Execs, and revokes sessions on role change', async () => {
    const users = new UserService(t.db);
    const team = await new TeamService(t.db).create(ctx({ ...admin, role: 'CS_LEAD' }), { name: 'Cards & EMI', description: null });
    const lead = await users.create(ctx(admin), {
      email: 'anjali@meridian.test', name: 'Anjali Rao', role: 'CS_LEAD', password: 'lead password 1234',
      teamIds: [], languages: [], skills: [], maxConcurrent: 8,
    });
    const leadP: Principal = { userId: lead.id, role: 'CS_LEAD', displayName: lead.name, teamIds: [], via: 'UI' };
    const exec = await users.create(ctx(leadP), {
      email: 'nikhil@meridian.test', name: 'Nikhil Menon', role: 'CS_EXEC', password: 'exec password 1234',
      teamIds: [team.id], languages: ['en', 'mr'], skills: ['cards'], maxConcurrent: 8,
    });
    expect(exec.teamIds).toEqual([team.id]);
    await expect(
      users.create(ctx(leadP), { email: 'x@y.test', name: 'X', role: 'PLATFORM_TECH_ADMIN', password: 'some password 123', teamIds: [], languages: [], skills: [], maxConcurrent: 8 }),
    ).rejects.toMatchObject({ category: 'authorization' });

    const execSession = await sessionsSvc().login('nikhil@meridian.test', 'exec password 1234', { correlationId: 'c' });
    await users.update(ctx(admin), exec.id, { role: 'CS_LEAD' });
    expect(await sessionsSvc().authenticate(execSession.token)).toBeNull();

    const { rows } = await t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`, [exec.id]);
    expect(rows.map((r) => r.action)).toEqual(['user.create', 'auth.login', 'user.role_change']);
  });

  it('validates worker settings bounds', async () => {
    const settings = new SettingsService(t.db);
    await expect(settings.updateWorkers(ctx(admin), { minWarmWorkers: 20 })).rejects.toThrow();
    const updated = await settings.updateWorkers(ctx(admin), { minWarmWorkers: 4 });
    expect(updated.minWarmWorkers).toBe(4);
    await expect(settings.updateWorkers(ctx({ ...admin, role: 'CS_LEAD' }), { minWarmWorkers: 3 })).rejects.toMatchObject({
      category: 'authorization',
    });
    const [{ n }] = (await t.db.execute(sql`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'config.changed'`)).rows as [{ n: number }];
    expect(n).toBe(1);
  });
});
