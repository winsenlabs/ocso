import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Permission as P, ROLE_PERMISSIONS } from '@ocso/auth';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { auditEvents, authSessions, teamMembers, userPermissionGrants, users } from '@ocso/db';
import { activateUser, applyPermissionChangeSet, loadPrincipal, type ActorContext } from '../src/index.js';
import { actorOf, addPerson, addTeam } from './support/identity-fixture.js';

/**
 * Per-user permissions applied (PM/research/11 §3.3): what the permission_change
 * and user approval descriptors run, called directly. loadPrincipal computes
 * preset ∪ active grants − active revokes, honouring expiry.
 */
let t: TestDatabase;
let admin: ActorContext;
const ids = { tech: '', lead: '', exec: '', cards: '', loans: '' };
const reason = 'integration test';
const actions = async (userId: string) =>
  (await t.db.select({ action: auditEvents.action }).from(auditEvents).where(eq(auditEvents.targetId, userId)).orderBy(auditEvents.occurredAt)).map((r) => r.action);

beforeAll(async () => {
  t = await createTestDatabase();
  ids.cards = await addTeam(t.db, 'Cards');
  ids.loans = await addTeam(t.db, 'Loans');
  ids.tech = await addPerson(t.db, { name: 'Tara Tech', role: 'TECH', password: true });
  ids.lead = await addPerson(t.db, { name: 'Leo Lead', role: 'LEAD', teamIds: [ids.cards] });
  ids.exec = await addPerson(t.db, { name: 'Esha Service', role: 'SERVICE', teamIds: [ids.cards] });
  admin = await actorOf(t.db, ids.tech);
});
afterAll(async () => {
  await t?.drop();
});

describe('loadPrincipal', () => {
  it('is the preset when there are no overrides', async () => {
    const p = await loadPrincipal(t.db, ids.exec, 'UI');
    expect([...(p?.permissions ?? [])].sort()).toEqual([...ROLE_PERMISSIONS.SERVICE].sort());
    expect(p?.teamIds).toEqual([ids.cards]);
  });

  it('adds grants and removes revokes from the next request on', async () => {
    const applied = await t.db.transaction((tx) =>
      applyPermissionChangeSet(tx, admin, { userId: ids.exec, ops: [{ op: 'GRANT', permission: P.QUEUES_MANAGE, expiresAt: null }, { op: 'REVOKE', permission: P.COPILOT_USE }], reason }, { proposalId: '00000000-0000-4000-8000-00000000abcd' }),
    );
    expect(applied.classification.direction).toBe('INCREASE');
    const p = await loadPrincipal(t.db, ids.exec, 'UI');
    expect(p?.permissions?.has(P.QUEUES_MANAGE)).toBe(true);
    expect(p?.permissions?.has(P.COPILOT_USE)).toBe(false);
    const [grant] = await t.db.select().from(userPermissionGrants).where(and(eq(userPermissionGrants.userId, ids.exec), eq(userPermissionGrants.permission, P.QUEUES_MANAGE)));
    expect(grant).toMatchObject({ effect: 'GRANT', proposalId: '00000000-0000-4000-8000-00000000abcd', createdBy: ids.tech, reason });
    expect(await actions(ids.exec)).toEqual(['user.permissions_increased']);
  });

  it('honours expiry without any sweep', async () => {
    // A grant that ends in a second (written directly: rows are never edited, so the clock has to pass).
    await t.pool.query(`INSERT INTO user_permission_grants (id, user_id, permission, effect, reason, expires_at) VALUES (gen_random_uuid(), $1, $2, 'GRANT', 'short', now() + interval '1 second')`, [ids.exec, P.SLA_MANAGE]);
    expect((await loadPrincipal(t.db, ids.exec, 'UI'))?.permissions?.has(P.SLA_MANAGE)).toBe(true);
    // Only the database clock decides.
    await t.pool.query('SELECT pg_sleep(1.1)');
    expect((await loadPrincipal(t.db, ids.exec, 'UI'))?.permissions?.has(P.SLA_MANAGE)).toBe(false);
    const rows = await t.db.select().from(userPermissionGrants).where(and(eq(userPermissionGrants.userId, ids.exec), eq(userPermissionGrants.permission, P.SLA_MANAGE), isNull(userPermissionGrants.clearedAt)));
    expect(rows).toHaveLength(1);
  });

  it('ignores cleared rows and permission names no longer in the catalogue', async () => {
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.exec, ops: [{ op: 'CLEAR', permission: P.COPILOT_USE }], reason }));
    await t.pool.query(`INSERT INTO user_permission_grants (id, user_id, permission, effect, reason) VALUES (gen_random_uuid(), $1, 'legacy.gone', 'GRANT', 'old')`, [ids.exec]);
    const p = await loadPrincipal(t.db, ids.exec, 'UI');
    expect(p?.permissions?.has(P.COPILOT_USE)).toBe(true);
    expect([...(p?.permissions ?? [])].every((x) => x !== ('legacy.gone' as P))).toBe(true);
  });

  it('keeps one live override per permission (a new op clears the previous one)', async () => {
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.exec, ops: [{ op: 'REVOKE', permission: P.QUEUES_MANAGE }], reason }));
    const live = await t.db.select().from(userPermissionGrants).where(and(eq(userPermissionGrants.userId, ids.exec), eq(userPermissionGrants.permission, P.QUEUES_MANAGE), isNull(userPermissionGrants.clearedAt)));
    expect(live.map((r) => r.effect)).toEqual(['REVOKE']);
    await expect(
      t.pool.query(`INSERT INTO user_permission_grants (id, user_id, permission, effect, reason) VALUES (gen_random_uuid(), $1, $2, 'GRANT', 'dup')`, [ids.exec, P.QUEUES_MANAGE]),
    ).rejects.toThrow(/user_permission_grants_open_uq/);
    await expect(
      t.pool.query(`INSERT INTO user_permission_grants (id, user_id, permission, effect, reason, expires_at) VALUES (gen_random_uuid(), $1, $2, 'REVOKE', 'x', now() + interval '1 day')`, [ids.exec, P.TEAMS_MANAGE]),
    ).rejects.toThrow(/user_permission_grants_expiry_ck/);
  });
});

describe('applying a change set', () => {
  it('changes preset and memberships, ends sessions on a preset change, and audits a decrease', async () => {
    await t.pool.query(`INSERT INTO auth_sessions (id, token, user_id, expires_at) VALUES (gen_random_uuid(), 'tok-lead', $1, now() + interval '1 day')`, [ids.lead]);
    const applied = await t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.lead, role: 'SERVICE', teams: { add: [], remove: [ids.cards] }, ops: [], reason }));
    expect(applied.classification.direction).toBe('DECREASE');
    expect(applied.sessionsEnded).toBe(1);
    expect(await t.db.select().from(authSessions).where(eq(authSessions.userId, ids.lead))).toEqual([]);
    expect(await t.db.select().from(teamMembers).where(eq(teamMembers.userId, ids.lead))).toEqual([]);
    const [audit] = await t.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, ids.lead), eq(auditEvents.action, 'user.permissions_reduced')));
    expect(audit?.before).toMatchObject({ role: 'LEAD', teamIds: [ids.cards] });
    expect(audit?.after).toMatchObject({ role: 'SERVICE', teamIds: [] });
  });

  it('refuses unknown teams and grants that already expired', async () => {
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.lead, teams: { add: ['00000000-0000-4000-8000-000000000999'], remove: [] }, ops: [], reason }))).rejects.toMatchObject({ code: 'unknown_team' });
    await expect(
      t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.lead, ops: [{ op: 'GRANT', permission: P.TEAMS_MANAGE, expiresAt: new Date(Date.now() - 1000).toISOString() }], reason })),
    ).rejects.toMatchObject({ code: 'grant_expiry_past' });
  });

  it('never removes the last break-glass Tech admin, by preset or by revoking users.manage', async () => {
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.tech, role: 'HEAD', ops: [], reason }))).rejects.toMatchObject({ code: 'last_password_admin' });
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.tech, ops: [{ op: 'REVOKE', permission: P.USERS_MANAGE }], reason }))).rejects.toMatchObject({ code: 'last_password_admin' });
    const tech2 = await addPerson(t.db, { name: 'Tomas Tech', role: 'TECH', password: true });
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: tech2, ops: [{ op: 'REVOKE', permission: P.USERS_MANAGE }], reason }));
    // A Tech without users.manage does not count as break-glass.
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, admin, { userId: ids.tech, role: 'HEAD', ops: [], reason }))).rejects.toMatchObject({ code: 'last_password_admin' });
  });
});

describe('activating a user', () => {
  it('turns a pending user ACTIVE (then they can sign in), and re-enables a disabled one', async () => {
    const pending = await addPerson(t.db, { name: 'Pia Pending', role: 'SERVICE', status: 'PENDING_APPROVAL' });
    expect(await loadPrincipal(t.db, pending, 'UI')).toBeNull();
    const activated = await t.db.transaction((tx) => activateUser(tx, admin, pending, { proposalId: '00000000-0000-4000-8000-00000000beef' }));
    expect(activated).toMatchObject({ id: pending, from: 'PENDING_APPROVAL', role: 'SERVICE' });
    expect(await loadPrincipal(t.db, pending, 'UI')).not.toBeNull();
    await expect(t.db.transaction((tx) => activateUser(tx, admin, pending))).rejects.toMatchObject({ code: 'user_already_active' });

    const disabled = await addPerson(t.db, { name: 'Dev Disabled', role: 'SERVICE', status: 'DISABLED' });
    expect((await t.db.transaction((tx) => activateUser(tx, admin, disabled))).from).toBe('DISABLED');
    expect(await actions(pending)).toEqual(['user.activate']);
    expect(await actions(disabled)).toEqual(['user.enable']);
  });

  it('the status CHECK admits exactly the three statuses', async () => {
    await expect(t.pool.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [ids.exec])).rejects.toThrow(/users_status_ck/);
    const [row] = await t.db.select({ status: users.status }).from(users).where(eq(users.id, ids.exec));
    expect(row?.status).toBe('ACTIVE');
  });
});
