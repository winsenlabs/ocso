import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Permission as P } from '@ocso/auth';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { teamMembers, users } from '@ocso/db';
import {
  PermissionService,
  TeamService,
  UserService,
  applyPermissionChangeSet,
  loadPrincipal,
  type IdentityApprovals,
  type IdentityProposalRequest,
  type PermissionChangeSet,
} from '../src/index.js';
import { actorOf, addPerson, addTeam } from './support/identity-fixture.js';

/**
 * Increase vs decrease through the services (PM/research/11 §3.4): decreases
 * apply at once, increases are proposed (or 409 approval_required) and never
 * apply; maker rules (never self, shared team, containment).
 */
let t: TestDatabase;
const ids = { tech: '', head: '', head2: '', lead: '', exec: '', cards: '', loans: '' };
const submitted: IdentityProposalRequest[] = [];
const spine: IdentityApprovals = {
  async submit(_actor, request) {
    submitted.push(request);
    return { id: `p-${submitted.length}`, objectKind: request.objectKind, objectId: request.objectId, action: request.action, status: 'SUBMITTED', checkerId: 'checkerId' in request.approval ? request.approval.checkerId : null, bootstrap: 'bootstrap' in request.approval };
  },
};
const CHECKER = { checkerId: '00000000-0000-4000-8000-0000000000cc' };
const reason = 'governance test';
const has = async (userId: string, permission: P) => Boolean((await loadPrincipal(t.db, userId, 'UI'))?.permissions?.has(permission));

beforeAll(async () => {
  t = await createTestDatabase();
  ids.cards = await addTeam(t.db, 'Cards');
  ids.loans = await addTeam(t.db, 'Loans');
  ids.tech = await addPerson(t.db, { name: 'Tara Tech', role: 'TECH', password: true });
  ids.head = await addPerson(t.db, { name: 'Hana Head', role: 'HEAD', teamIds: [ids.cards] });
  ids.head2 = await addPerson(t.db, { name: 'Omar Head', role: 'HEAD', teamIds: [ids.loans] });
  ids.lead = await addPerson(t.db, { name: 'Leo Lead', role: 'LEAD', teamIds: [ids.cards] });
  ids.exec = await addPerson(t.db, { name: 'Esha Service', role: 'SERVICE', teamIds: [ids.cards] });
});
afterAll(async () => {
  await t?.drop();
});

describe('PermissionService.change', () => {
  const service = () => new PermissionService(t.db);

  it('applies a decrease at once and audits it', async () => {
    const result = await service().change(await actorOf(t.db, ids.head), ids.exec, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }], reason });
    expect(result).toMatchObject({ applied: true, direction: 'DECREASE' });
    expect(await has(ids.exec, P.COPILOT_USE)).toBe(false);
  });

  it('refuses an increase with 409 approval_required and applies nothing', async () => {
    const head = await actorOf(t.db, ids.head);
    for (const body of [
      { changes: [{ op: 'GRANT' as const, permission: P.SLA_MANAGE }], reason },
      { changes: [{ op: 'CLEAR' as const, permission: P.COPILOT_USE }], reason },
      { preset: 'LEAD' as const, changes: [], reason },
      // The spine is not wired yet: naming a checker still cannot apply it.
      { changes: [{ op: 'GRANT' as const, permission: P.SLA_MANAGE }], reason, approval: CHECKER },
    ]) {
      await expect(service().change(head, ids.exec, body)).rejects.toMatchObject({ category: 'conflict', code: 'approval_required', details: { objectKind: 'permission_change', action: 'UPDATE', objectId: ids.exec } });
    }
    expect(await has(ids.exec, P.SLA_MANAGE)).toBe(false);
    expect(await has(ids.exec, P.COPILOT_USE)).toBe(false);
    const [row] = await t.db.select({ role: users.role }).from(users).where(eq(users.id, ids.exec));
    expect(row?.role).toBe('SERVICE');
  });

  it('submits an increase to the spine with a replayable change set, which approval applies', async () => {
    const result = await new PermissionService(t.db, { approvals: spine }).change(await actorOf(t.db, ids.head), ids.exec, {
      changes: [{ op: 'GRANT', permission: P.SLA_MANAGE, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }],
      reason,
      approval: CHECKER,
    });
    expect(result).toMatchObject({ applied: false, direction: 'INCREASE', proposal: { objectKind: 'permission_change', objectId: ids.exec, checkerId: CHECKER.checkerId } });
    expect(await has(ids.exec, P.SLA_MANAGE)).toBe(false);
    const request = submitted.at(-1)!;
    expect(request).toMatchObject({ objectKind: 'permission_change', action: 'UPDATE', reason });
    // What the permission_change descriptor does on approval.
    const tech = await actorOf(t.db, ids.tech);
    await t.db.transaction((tx) => applyPermissionChangeSet(tx, tech, request.payload as PermissionChangeSet, { proposalId: '00000000-0000-4000-8000-0000000000aa' }));
    expect(await has(ids.exec, P.SLA_MANAGE)).toBe(true);
  });

  it('never lets someone change their own access', async () => {
    await expect(service().change(await actorOf(t.db, ids.head), ids.head, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }], reason })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('needs permissions.manage for grants and revokes', async () => {
    await expect(service().change(await actorOf(t.db, ids.lead), ids.exec, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason })).rejects.toMatchObject({ category: 'authorization' });
  });

  it('keeps team makers inside their teams and their own rights', async () => {
    const head2 = await actorOf(t.db, ids.head2);
    await expect(service().change(head2, ids.exec, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason })).rejects.toMatchObject({ category: 'authorization' });
    const head = await actorOf(t.db, ids.head);
    // Granting what the maker lacks exceeds their own rights (containment), even as a proposal.
    await expect(new PermissionService(t.db, { approvals: spine }).change(head, ids.lead, { changes: [{ op: 'GRANT', permission: P.SECRETS_MANAGE }], reason, approval: CHECKER })).rejects.toMatchObject({ category: 'authorization' });
    // A Tech (users.manage) is not team-scoped.
    const tech = await actorOf(t.db, ids.tech);
    expect(await service().change(tech, ids.lead, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason })).toMatchObject({ applied: true });
  });

  it('shows effective permissions with their sources to readers who share a team', async () => {
    const view = await service().forUser(await actorOf(t.db, ids.head), ids.exec);
    const row = (p: P) => view.effective.find((e) => e.permission === p);
    expect(view.preset).toBe('SERVICE');
    expect(row(P.CONVERSATIONS_REPLY)?.sources).toEqual([{ kind: 'PRESET', preset: 'SERVICE' }]);
    // The grant row records the maker (the checker is on the proposal).
    expect(row(P.SLA_MANAGE)).toMatchObject({ active: true, group: 'Routing and queues', sources: [{ kind: 'GRANT', proposalId: '00000000-0000-4000-8000-0000000000aa', grantedBy: { id: ids.head, name: 'Hana Head' } }] });
    expect(row(P.COPILOT_USE)).toMatchObject({ active: false, revoked: { reason, revokedBy: { id: ids.head, name: 'Hana Head' } } });
    expect(view.overrides.map((o) => [o.permission, o.effect, o.expired]).sort()).toEqual([
      [P.COPILOT_USE, 'REVOKE', false],
      [P.SLA_MANAGE, 'GRANT', false],
    ]);
    await expect(service().forUser(await actorOf(t.db, ids.head2), ids.exec)).rejects.toMatchObject({ category: 'not_found' });
    await expect(service().forUser(await actorOf(t.db, ids.exec), ids.lead)).rejects.toMatchObject({ category: 'authorization' });
    expect((await service().forUser(await actorOf(t.db, ids.tech), ids.exec)).userId).toBe(ids.exec);
  });
});

describe('users and memberships', () => {
  it('creates users pending approval: inert, unable to sign in, and submitted when a checker is named', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const created = await new UserService(t.db, { allowInitialPasswords: true }).create(tech, { email: 'new@perms.test', name: 'New', role: 'SERVICE', password: 'a password 12345' });
    expect(created).toMatchObject({ status: 'PENDING_APPROVAL', onboarding: { kind: 'pending_approval' }, proposal: null, approvalRequired: { objectKind: 'user', action: 'CREATE' } });
    expect(await loadPrincipal(t.db, created.id, 'UI')).toBeNull();
    const proposed = await new UserService(t.db, { allowInitialPasswords: true, approvals: spine }).create(tech, { email: 'new2@perms.test', name: 'New Two', role: 'LEAD', password: 'a password 12345', approval: CHECKER });
    expect(proposed).toMatchObject({ status: 'PENDING_APPROVAL', proposal: { objectKind: 'user', action: 'CREATE', objectId: proposed.id }, approvalRequired: null });
    // The approval binds the rights the checker sees.
    expect(submitted.at(-1)?.payload).toEqual({ userId: proposed.id, makerId: ids.tech, rights: { role: 'LEAD', teamIds: [], overrides: [] } });
    // A pending user becomes active only through approval.
    await expect(new UserService(t.db).update(tech, created.id, { status: 'ACTIVE' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'user', action: 'CREATE' } });
  });

  it('classifies PATCH: downgrades and removals apply, upgrades and additions need approval', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const users$ = new UserService(t.db);
    await expect(users$.update(tech, ids.lead, { role: 'HEAD' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change' } });
    await expect(users$.update(tech, ids.lead, { teamIds: [ids.cards, ids.loans] })).rejects.toMatchObject({ code: 'approval_required' });
    // Profile fields ride along with a proposal, never with a refusal.
    const proposed = await new UserService(t.db, { approvals: spine }).update(tech, ids.lead, { role: 'HEAD', name: 'Leo L.', approval: CHECKER });
    expect(proposed).toMatchObject({ name: 'Leo L.', role: 'LEAD', proposal: { objectKind: 'permission_change' } });
    expect(submitted.at(-1)?.payload).toMatchObject({ userId: ids.lead, role: 'HEAD', ops: [] });
    expect((await users$.update(tech, ids.lead, { role: 'SERVICE' })).role).toBe('SERVICE');
    expect((await users$.update(tech, ids.lead, { teamIds: [] })).teamIds).toEqual([]);
    expect((await users$.update(tech, ids.lead, { status: 'DISABLED' })).status).toBe('DISABLED');
    await expect(users$.update(tech, ids.lead, { status: 'ACTIVE' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'user', action: 'ACTIVATE' } });
    await expect(users$.update(tech, ids.lead, { status: 'ACTIVE', role: 'LEAD' })).rejects.toMatchObject({ code: 'activate_alone' });
  });

  it('team additions of an approved user need approval; removals and pending users apply', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const teams$ = new TeamService(t.db);
    await expect(teams$.addMember(tech, ids.loans, { userId: ids.exec })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change', objectId: ids.exec } });
    expect((await new TeamService(t.db, { approvals: spine }).addMember(tech, ids.loans, { userId: ids.exec, approval: CHECKER })).proposal).toMatchObject({ objectKind: 'permission_change' });
    expect(submitted.at(-1)?.payload).toMatchObject({ userId: ids.exec, teams: { add: [ids.loans], remove: [] } });
    const pending = await addPerson(t.db, { name: 'Pat Pending', role: 'SERVICE', status: 'PENDING_APPROVAL' });
    expect((await teams$.addMember(tech, ids.loans, { userId: pending })).proposal).toBeNull();
    await teams$.removeMember(tech, ids.cards, ids.exec);
    const memberships = await t.db.select().from(teamMembers).where(eq(teamMembers.userId, ids.exec));
    expect(memberships).toEqual([]);
  });

  it('skips approval only when the deployment says so (development)', async () => {
    const tech = await actorOf(t.db, ids.tech);
    const dev = new UserService(t.db, { allowInitialPasswords: true, skipAccessApproval: true });
    const created = await dev.create(tech, { email: 'dev@perms.test', name: 'Dev', role: 'SERVICE', password: 'a password 12345' });
    expect(created).toMatchObject({ status: 'ACTIVE', onboarding: { kind: 'password' }, approvalRequired: null });
    expect((await dev.update(tech, created.id, { role: 'LEAD' })).role).toBe('LEAD');
    // Grants are never skipped.
    await expect(new PermissionService(t.db, { skipAccessApproval: true }).change(tech, created.id, { changes: [{ op: 'GRANT', permission: P.TEAMS_MANAGE }], reason })).rejects.toMatchObject({ code: 'approval_required' });
  });
});
