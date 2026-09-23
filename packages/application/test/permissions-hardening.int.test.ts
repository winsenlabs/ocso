import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { Permission as P } from '@ocso/auth';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { auditEvents, authSessions, teamMembers, userPermissionGrants, users, uuidv7 } from '@ocso/db';
import {
  AuthPolicyService,
  PermissionService,
  SessionLiveness,
  TeamService,
  UserService,
  activateUser,
  applyPermissionChangeSet,
  holdsPermissionSql,
  loadPrincipal,
  type IdentityApprovals,
  type IdentityProposalRequest,
  type PermissionChangeSet,
  type UserProposalPayload,
} from '../src/index.js';
import { actorOf, addPerson, addTeam } from './support/identity-fixture.js';

/**
 * The review's findings on per-user permissions (ADR-029), end to end through
 * the services on a real database: reductions apply even beside an increase,
 * approved users stay governed while disabled, user approvals bind the rights
 * they approve, makers are re-validated at activation, Tech never holds
 * conversation content, the grant history cannot be edited, and effective
 * permissions (not presets) decide routing, streams and MFA.
 */
let t: TestDatabase;
const ids = { tech: '', head: '', lead: '', exec: '', exec2: '', cards: '', loans: '' };
const submitted: IdentityProposalRequest[] = [];
const spine: IdentityApprovals = {
  async submit(_actor, request) {
    submitted.push(request);
    return { id: uuidv7(), objectKind: request.objectKind, objectId: request.objectId, action: request.action, status: 'SUBMITTED', checkerId: null, bootstrap: false };
  },
};
const CHECKER = { checkerId: '00000000-0000-4000-8000-0000000000cc' };
const reason = 'hardening test';
const has = async (userId: string, permission: P) => Boolean((await loadPrincipal(t.db, userId, 'UI'))?.permissions?.has(permission));
const teamsOf = async (userId: string) => (await t.db.select({ id: teamMembers.teamId }).from(teamMembers).where(eq(teamMembers.userId, userId))).map((r) => r.id).sort();
const lastAudit = async (userId: string, action: string) =>
  (await t.db.select().from(auditEvents).where(and(eq(auditEvents.targetId, userId), eq(auditEvents.action, action))).orderBy(auditEvents.occurredAt)).at(-1);

beforeAll(async () => {
  t = await createTestDatabase();
  ids.cards = await addTeam(t.db, 'Cards');
  ids.loans = await addTeam(t.db, 'Loans');
  ids.tech = await addPerson(t.db, { name: 'Tara Tech', role: 'TECH', password: true });
  await addPerson(t.db, { name: 'Tom Tech', role: 'TECH', password: true });
  ids.head = await addPerson(t.db, { name: 'Hana Head', role: 'HEAD', teamIds: [ids.cards] });
  ids.lead = await addPerson(t.db, { name: 'Leo Lead', role: 'LEAD', teamIds: [ids.cards] });
  ids.exec = await addPerson(t.db, { name: 'Esha Service', role: 'SERVICE', teamIds: [ids.cards] });
  ids.exec2 = await addPerson(t.db, { name: 'Ezra Service', role: 'SERVICE', teamIds: [ids.cards] });
});
afterAll(async () => {
  await t?.drop();
});

describe('reductions apply at once even beside an increase', () => {
  it('REVOKE + GRANT: the revoke applies; the grant is refused (409 saying what applied) or proposed', async () => {
    const head = await actorOf(t.db, ids.head);
    const body = { changes: [{ op: 'REVOKE' as const, permission: P.APPROVALS_READ }, { op: 'GRANT' as const, permission: P.SLA_MANAGE }], reason };
    await expect(new PermissionService(t.db).change(head, ids.exec, body)).rejects.toMatchObject({
      code: 'approval_required',
      message: expect.stringMatching(/reductions in this change were applied/),
      details: { objectKind: 'permission_change', applied: { lost: [P.APPROVALS_READ] } },
    });
    expect(await has(ids.exec, P.APPROVALS_READ)).toBe(false);
    expect(await has(ids.exec, P.SLA_MANAGE)).toBe(false);
    const result = await new PermissionService(t.db, { approvals: spine }).change(head, ids.exec, { ...body, changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }, { op: 'GRANT', permission: P.SLA_MANAGE }], approval: CHECKER });
    expect(result).toMatchObject({ applied: true, direction: 'INCREASE', appliedClassification: { lost: [P.COPILOT_USE] }, proposal: { objectKind: 'permission_change' } });
    // Only the widening part waits, with the maker recorded.
    expect(submitted.at(-1)?.payload).toMatchObject({ userId: ids.exec, makerId: ids.head, ops: [{ op: 'GRANT', permission: P.SLA_MANAGE }] });
    expect(await has(ids.exec, P.COPILOT_USE)).toBe(false);
  });

  it('a team move over PATCH: leaving applies, joining waits', async () => {
    const tech = await actorOf(t.db, ids.tech);
    await expect(new UserService(t.db).update(tech, ids.exec2, { teamIds: [ids.loans] })).rejects.toMatchObject({ code: 'approval_required', details: { applied: { teamsRemoved: [ids.cards] } } });
    expect(await teamsOf(ids.exec2)).toEqual([]);
  });

  it('a downgrade plus a team: the downgrade applies, the team is proposed', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const updated = await new UserService(t.db, { approvals: spine }).update(tech, ids.lead, { role: 'SERVICE', teamIds: [ids.cards, ids.loans], approval: CHECKER });
    expect(updated).toMatchObject({ role: 'SERVICE', teamIds: [ids.cards], proposal: { objectKind: 'permission_change' } });
    expect(submitted.at(-1)?.payload).toMatchObject({ userId: ids.lead, teams: { add: [ids.loans], remove: [] }, makerId: ids.tech });
  });
});

describe('approved users stay governed while disabled', () => {
  it('disable, upgrade and re-enable cannot smuggle an upgrade past a checker', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const service = new UserService(t.db, { approvals: spine });
    const target = await addPerson(t.db, { name: 'Dina Disabled', role: 'SERVICE', teamIds: [ids.cards] });
    expect((await service.update(tech, target, { status: 'DISABLED' })).status).toBe('DISABLED');
    await expect(new UserService(t.db).update(tech, target, { role: 'TECH' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change' } });
    expect((await service.get(target)).role).toBe('SERVICE');
    // Re-enabling is proposed with the rights it restores; activation refuses any other state.
    const proposal = await service.update(tech, target, { status: 'ACTIVE', approval: CHECKER });
    expect(proposal.proposal).toMatchObject({ objectKind: 'user', action: 'ACTIVATE' });
    const payload = submitted.at(-1)!.payload as UserProposalPayload;
    expect(payload.rights).toEqual({ role: 'SERVICE', teamIds: [ids.cards], overrides: [] });
    await t.db.update(users).set({ role: 'HEAD' }).where(eq(users.id, target));
    await expect(t.db.transaction((tx) => activateUser(tx, tech, target, { proposalId: uuidv7(), expected: payload.rights, makerId: payload.makerId }))).rejects.toMatchObject({ code: 'user_changed_since_proposal' });
    await t.db.update(users).set({ role: 'SERVICE' }).where(eq(users.id, target));
    await t.db.transaction((tx) => activateUser(tx, tech, target, { proposalId: uuidv7(), expected: payload.rights, makerId: payload.makerId }));
    expect(await has(target, P.CONVERSATIONS_REPLY)).toBe(true);
  });

  it('adding a disabled user to a team is an increase', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const target = await addPerson(t.db, { name: 'Dora Disabled', role: 'SERVICE', status: 'DISABLED' });
    await expect(new TeamService(t.db).addMember(tech, ids.cards, { userId: target })).rejects.toMatchObject({ code: 'approval_required' });
  });
});

describe('pending users: drafts whose creation approval binds their rights', () => {
  it('PATCH with approval submits the creation; later edits void it at activation', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const service = new UserService(t.db, { allowInitialPasswords: true, approvals: spine });
    const created = await service.create(tech, { email: 'draft@perms.test', name: 'Drafty', role: 'SERVICE', password: 'a password 12345', teamIds: [ids.cards] });
    expect(created).toMatchObject({ status: 'PENDING_APPROVAL', proposal: null });
    // Draft edits apply directly; submitting binds what the checker sees.
    const submittedNow = await service.update(tech, created.id, { role: 'LEAD', approval: CHECKER });
    expect(submittedNow).toMatchObject({ role: 'LEAD', status: 'PENDING_APPROVAL', proposal: { objectKind: 'user', action: 'CREATE' } });
    const payload = submitted.at(-1)!.payload as UserProposalPayload;
    expect(payload).toEqual({ userId: created.id, makerId: ids.tech, rights: { role: 'LEAD', teamIds: [ids.cards], overrides: [] } });
    await service.update(tech, created.id, { role: 'HEAD' });
    await expect(t.db.transaction((tx) => activateUser(tx, tech, created.id, { proposalId: uuidv7(), expected: payload.rights, makerId: ids.tech }))).rejects.toMatchObject({ code: 'user_changed_since_proposal' });
  });

  it('a pending user is never disabled (so never re-enabled around its creation), but can be discarded', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const service = new UserService(t.db, { allowInitialPasswords: true });
    const created = await service.create(tech, { email: 'discard@perms.test', name: 'Gone', role: 'SERVICE', password: 'a password 12345', teamIds: [ids.cards] });
    await expect(service.update(tech, created.id, { status: 'DISABLED' })).rejects.toMatchObject({ code: 'user_pending_approval' });
    await expect(service.discard(tech, ids.exec)).rejects.toMatchObject({ code: 'user_not_pending' });
    await expect(service.discard(await actorOf(t.db, ids.exec), created.id)).rejects.toMatchObject({ category: 'authorization' });
    await service.discard(tech, created.id);
    expect(await t.db.select().from(users).where(eq(users.id, created.id))).toEqual([]);
    expect((await lastAudit(created.id, 'user.discard'))?.summary).toMatch(/never approved/);
    // The email is free again.
    expect((await service.create(tech, { email: 'discard@perms.test', name: 'Back', role: 'SERVICE', password: 'a password 12345' })).status).toBe('PENDING_APPROVAL');
  });

  it('a creation whose approval cannot be submitted leaves nothing behind', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const service = new UserService(t.db, { allowInitialPasswords: true, approvals: spine });
    await expect(service.create(tech, { email: 'self@perms.test', name: 'Self', role: 'SERVICE', password: 'a password 12345', approval: { checkerId: ids.tech } })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    expect(await t.db.select().from(users).where(eq(users.email, 'self@perms.test'))).toEqual([]);
  });

  it('a team-scoped maker must place a new user in one of their teams', async () => {
    const head = await actorOf(t.db, ids.head);
    await expect(new UserService(t.db, { allowInitialPasswords: true }).create(head, { email: 'orphan@perms.test', name: 'Orphan', role: 'SERVICE', password: 'a password 12345' })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('development deployments activate a pending user on PATCH ACTIVE and hand out the first sign-in, audited as skipped', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const created = await new UserService(t.db, { allowInitialPasswords: true }).create(tech, { email: 'devpend@perms.test', name: 'Dev Pending', role: 'SERVICE', password: 'a password 12345' });
    const dev = new UserService(t.db, { allowInitialPasswords: true, skipAccessApproval: true, skipReason: 'dev_flag' });
    expect(await dev.update(tech, created.id, { status: 'ACTIVE' })).toMatchObject({ status: 'ACTIVE', onboarding: { kind: 'password' } });
    expect((await lastAudit(created.id, 'user.activate'))?.after).toMatchObject({ approvalSkipped: 'dev_flag', proposalId: null });
  });
});

describe('who may make it, re-checked when it applies', () => {
  it('the checker is never the maker nor the target', async () => {
    const head = await actorOf(t.db, ids.head);
    const service = new PermissionService(t.db, { approvals: spine });
    const body = { changes: [{ op: 'GRANT' as const, permission: P.SLA_MANAGE }], reason };
    await expect(service.change(head, ids.exec, { ...body, approval: { checkerId: ids.head } })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    await expect(service.change(head, ids.exec, { ...body, approval: { checkerId: ids.exec } })).rejects.toMatchObject({ code: 'checker_not_eligible' });
  });

  it('an approved change whose maker lost the right to make it is refused, and grant rows name the maker', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const maker = await addPerson(t.db, { name: 'Mara Head', role: 'HEAD', teamIds: [ids.cards] });
    const target = await addPerson(t.db, { name: 'Tess Target', role: 'SERVICE', teamIds: [ids.cards] });
    const set: PermissionChangeSet = { userId: target, makerId: maker, ops: [{ op: 'GRANT', permission: P.EVALUATIONS_RUN, expiresAt: null }], reason };
    await t.db.update(users).set({ role: 'LEAD' }).where(eq(users.id, maker));
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, set, { proposalId: uuidv7() }))).rejects.toMatchObject({ code: 'maker_no_longer_eligible' });
    await t.db.update(users).set({ role: 'HEAD' }).where(eq(users.id, maker));
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, set, { proposalId: uuidv7() }));
    const [row] = await t.db.select().from(userPermissionGrants).where(and(eq(userPermissionGrants.userId, target), eq(userPermissionGrants.permission, P.EVALUATIONS_RUN)));
    expect(row?.createdBy).toBe(maker);
    await t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, maker));
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, { ...set, ops: [{ op: 'GRANT', permission: P.REVIEWS_MANAGE, expiresAt: null }] }, { proposalId: uuidv7() }))).rejects.toMatchObject({ code: 'maker_not_active' });
  });

  it('Tech never holds conversation content, not even through an approved grant', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const other = await addPerson(t.db, { name: 'Tia Tech', role: 'TECH', password: true, teamIds: [ids.cards] });
    await expect(new PermissionService(t.db, { approvals: spine }).change(tech, other, { changes: [{ op: 'GRANT', permission: P.CONVERSATIONS_READ_TEAM }], reason, approval: CHECKER })).rejects.toMatchObject({ code: 'grant_not_allowed_for_preset' });
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, { userId: other, ops: [{ op: 'GRANT', permission: P.CONVERSATIONS_READ, expiresAt: null }], reason }, { proposalId: uuidv7() }))).rejects.toMatchObject({ code: 'grant_not_allowed_for_preset' });
    // A preset change to Tech cannot carry such a grant along.
    const lead = await addPerson(t.db, { name: 'Lina Lead', role: 'LEAD', teamIds: [ids.cards] });
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, { userId: lead, ops: [{ op: 'GRANT', permission: P.CUSTOMERS_READ, expiresAt: null }], reason }, { proposalId: uuidv7() }));
    await expect(t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, { userId: lead, role: 'TECH', ops: [], reason }, { proposalId: uuidv7() }))).rejects.toMatchObject({ code: 'grant_not_allowed_for_preset' });
  });

  it('nobody adds themselves to a team, even where approval is skipped', async () => {
    const tech = await actorOf(t.db, ids.tech);
    await expect(new TeamService(t.db, { skipAccessApproval: true }).addMember(tech, ids.cards, { userId: ids.tech })).rejects.toMatchObject({ category: 'authorization' });
  });
});

describe('the grant history cannot be edited', () => {
  it('rows change only by being cleared once, are never deleted, and keep their user', async () => {
    const [row] = await t.db.select().from(userPermissionGrants).where(eq(userPermissionGrants.userId, ids.exec)).limit(1);
    await expect(t.pool.query(`UPDATE user_permission_grants SET expires_at = now() + interval '9 days' WHERE id = $1`, [row!.id])).rejects.toThrow(/cleared/);
    await expect(t.pool.query(`DELETE FROM user_permission_grants WHERE id = $1`, [row!.id])).rejects.toThrow(/never delete/);
    await expect(t.pool.query(`DELETE FROM users WHERE id = $1`, [ids.exec])).rejects.toThrow(/user_permission_grants_user_id_users_id_fk/);
    await t.pool.query(`UPDATE user_permission_grants SET cleared_at = now(), cleared_by = $2 WHERE id = $1`, [row!.id, ids.tech]);
    await expect(t.pool.query(`UPDATE user_permission_grants SET cleared_at = now() WHERE id = $1`, [row!.id])).rejects.toThrow(/cleared/);
  });
});

describe('effective permissions, not presets, decide routing, streams and MFA', () => {
  it('routing picks only people who hold the permission now', async () => {
    const pick = async () => (await t.db.select({ id: users.id }).from(users).where(and(holdsPermissionSql(P.CONVERSATIONS_READ), sql`${users.status} = 'ACTIVE'`))).map((r) => r.id);
    const target = await addPerson(t.db, { name: 'Rita Routed', role: 'SERVICE', teamIds: [ids.cards] });
    expect(await pick()).toContain(target);
    expect(await pick()).not.toContain(ids.tech);
    await new PermissionService(t.db).change(await actorOf(t.db, ids.head), target, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_READ }], reason });
    expect(await pick()).not.toContain(target);
  });

  it('an open stream ends when its user loses a permission or a team', async () => {
    const target = await addPerson(t.db, { name: 'Sam Stream', role: 'SERVICE', teamIds: [ids.cards, ids.loans] });
    const sessionId = uuidv7();
    await t.db.insert(authSessions).values({ id: sessionId, token: `tok-${sessionId}`, userId: target, expiresAt: new Date(Date.now() + 3_600_000) });
    const liveness = new SessionLiveness(t.db, { idleMinutes: 60 }, new AuthPolicyService(t.db));
    const held = (await loadPrincipal(t.db, target, 'UI'))!;
    expect(await liveness.isLive(sessionId, new Date(), held)).toBe(true);
    await new TeamService(t.db).removeMember(await actorOf(t.db, ids.tech), ids.loans, target);
    expect(await liveness.isLive(sessionId, new Date(), held)).toBe(false);
    const again = (await loadPrincipal(t.db, target, 'UI'))!;
    expect(await liveness.isLive(sessionId, new Date(), again)).toBe(true);
    await new PermissionService(t.db).change(await actorOf(t.db, ids.head), target, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_READ }], reason });
    expect(await liveness.isLive(sessionId, new Date(), again)).toBe(false);
    // Without what the stream holds, only the session itself is checked (legacy callers).
    expect(await liveness.isLive(sessionId)).toBe(true);
  });

  it('a grant of an MFA-required preset permission requires MFA', async () => {
    const policy = new AuthPolicyService(t.db);
    await policy.update(await actorOf(t.db, ids.tech), { requireMfaRoles: ['TECH'] });
    const target = await addPerson(t.db, { name: 'Gus Granted', role: 'SERVICE', teamIds: [ids.cards] });
    const before = (await loadPrincipal(t.db, target, 'UI'))!;
    expect((await policy.mfaState(before.role, 'password', false, before.permissions)).required).toBe(false);
    const tech = await actorOf(t.db, ids.tech);
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, { userId: target, ops: [{ op: 'GRANT', permission: P.USERS_MANAGE, expiresAt: null }], reason }, { proposalId: uuidv7() }));
    const after = (await loadPrincipal(t.db, target, 'UI'))!;
    expect((await new AuthPolicyService(t.db).mfaState(after.role, 'password', false, after.permissions)).required).toBe(true);
    await policy.update(await actorOf(t.db, ids.tech), { requireMfaRoles: [] });
  });
});
