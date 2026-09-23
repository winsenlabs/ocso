import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import type { Principal } from '@ocso/auth';
import {
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

describe('user management', () => {
  let admin: Principal;

  beforeAll(async () => {
    const [row] = (await t.db.execute(sql`SELECT id, name FROM users WHERE email = 'tejas@meridian.test'`)).rows as [{ id: string; name: string }];
    admin = { userId: row.id, role: 'TECH', displayName: row.name, teamIds: [], via: 'UI' };
  });

  it('stores emails in lower case with an OCSO scrypt credential account (Better Auth model)', async () => {
    const { rows } = await t.pool.query(`SELECT u.email, u.email_verified, a.provider_id, a.password FROM users u JOIN auth_accounts a ON a.user_id = u.id`);
    expect(rows).toEqual([{ email: 'tejas@meridian.test', email_verified: true, provider_id: 'credential', password: expect.stringMatching(/^scrypt\$15\$8\$1\$/) }]);
  });

  it('lets a Lead manage only Service members, and revokes sessions on role change', async () => {
    const users = new UserService(t.db, { allowInitialPasswords: true });
    const team = await new TeamService(t.db).create(ctx({ ...admin, role: 'HEAD' }), { name: 'Cards & EMI', description: null });
    const lead = await users.create(ctx(admin), {
      email: 'anjali@meridian.test', name: 'Anjali Rao', role: 'HEAD', password: 'lead password 1234',
      teamIds: [team.id], languages: [], skills: [], maxConcurrent: 8,
    });
    // A lead places new execs only in teams they belong to (ADR-026).
    const leadP: Principal = { userId: lead.id, role: 'HEAD', displayName: lead.name, teamIds: [team.id], via: 'UI' };
    const exec = await users.create(ctx(leadP), {
      email: 'nikhil@meridian.test', name: 'Nikhil Menon', role: 'SERVICE', password: 'exec password 1234',
      teamIds: [team.id], languages: ['en', 'mr'], skills: ['cards'], maxConcurrent: 8,
    });
    expect(exec.teamIds).toEqual([team.id]);
    expect(exec.invite.status).toBe('none');
    await expect(
      users.create(ctx(leadP), { email: 'x@y.test', name: 'X', role: 'TECH', password: 'some password 123', teamIds: [], languages: [], skills: [], maxConcurrent: 8 }),
    ).rejects.toMatchObject({ category: 'authorization' });

    await t.pool.query(`INSERT INTO auth_sessions (id, token, user_id, expires_at) VALUES (gen_random_uuid(), 'tok-exec', $1, now() + interval '1 day')`, [exec.id]);
    await users.update(ctx(admin), exec.id, { role: 'HEAD' });
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM auth_sessions WHERE user_id = $1`, [exec.id])).rows[0].n).toBe(0);

    const { rows } = await t.pool.query(`SELECT action FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`, [exec.id]);
    expect(rows.map((r) => r.action)).toEqual(['user.create', 'user.role_change']);
  });

  it('refuses admin-set passwords when invites can be emailed', async () => {
    const users = new UserService(t.db, { allowInitialPasswords: false });
    await expect(users.create(ctx(admin), { email: 'p@meridian.test', name: 'P', role: 'SERVICE', password: 'some password 123' })).rejects.toMatchObject({ code: 'initial_password_not_allowed' });
  });

  it('validates worker settings bounds', async () => {
    const settings = new SettingsService(t.db);
    await expect(settings.updateWorkers(ctx(admin), { minWarmWorkers: 20 })).rejects.toThrow();
    const updated = await settings.updateWorkers(ctx(admin), { minWarmWorkers: 4 });
    expect(updated.minWarmWorkers).toBe(4);
    await expect(settings.updateWorkers(ctx({ ...admin, role: 'HEAD' }), { minWarmWorkers: 3 })).rejects.toMatchObject({
      category: 'authorization',
    });
    const [{ n }] = (await t.db.execute(sql`SELECT count(*)::int AS n FROM outbox_events WHERE type = 'config.changed'`)).rows as [{ n: number }];
    expect(n).toBe(1);
  });
});
