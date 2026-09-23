import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, Permission as P } from '@ocso/auth';
import { activateUser, applyPermissionChangeSet, loadPrincipal, type ActorContext } from '@ocso/application';
import { teamMembers, teams, uuidv7 } from '@ocso/db';
import { addUserWithPassword, completeSetup, startApi, type ApiHarness } from './harness.js';

/**
 * Per-user permissions over HTTP (PM/research/11 §3.5) on a governed deployment
 * (access approval not skipped): the catalogue, effective permissions with
 * sources, decreases applying at once, increases answering 409
 * approval_required, maker scoping and never-self, and users created pending.
 */
let h: ApiHarness;
const PASSWORD = 'a password 12345';
const tok = { admin: '', head: '', head2: '', lead: '', exec: '' };
const ids = { admin: '', head: '', head2: '', lead: '', exec: '', cards: '', loans: '' };
const as = (who: keyof typeof tok) => ({ authorization: `Bearer ${tok[who]}` });
const changes = (who: keyof typeof tok, userId: string, body: object) => h.http().post(`/v1/users/${userId}/permission-changes`).set(as(who)).send(body);
const reason = 'integration test';

beforeAll(async () => {
  h = await startApi({ env: { OCSO_DEV_SKIP_ACCESS_APPROVAL: 'false' } });
  tok.admin = await completeSetup(h);
  ids.admin = (await h.http().get('/v1/auth/me').set(as('admin')).expect(200)).body.id;
  ids.cards = uuidv7();
  ids.loans = uuidv7();
  await h.db.db.insert(teams).values([{ id: ids.cards, name: 'Cards' }, { id: ids.loans, name: 'Loans' }]);
  // Existing, approved colleagues (what the grandfather migration leaves ACTIVE).
  const people = { head: 'HEAD', head2: 'HEAD', lead: 'LEAD', exec: 'SERVICE' } as const;
  for (const [key, role] of Object.entries(people) as Array<[keyof typeof people, (typeof people)[keyof typeof people]]>) {
    ids[key] = await addUserWithPassword(h, { email: `${key}@ocso.test`, name: key, role, password: PASSWORD });
    await h.db.db.insert(teamMembers).values({ teamId: key === 'head2' ? ids.loans : ids.cards, userId: ids[key] });
    tok[key] = await h.loginAs(`${key}@ocso.test`, PASSWORD);
  }
});
afterAll(async () => {
  await h?.close();
});

const adminActor = async (): Promise<ActorContext> => ({ principal: (await loadPrincipal(h.db.db, ids.admin, 'SYSTEM'))!, correlationId: 'test' });

describe('GET /v1/permissions/catalogue', () => {
  it('describes every permission to any signed-in user', async () => {
    const res = await h.http().get('/v1/permissions/catalogue').set(as('exec')).expect(200);
    expect(res.body).toHaveLength(ALL_PERMISSIONS.length);
    expect(res.body.find((e: { permission: string }) => e.permission === P.APPROVALS_CHECK_PERMISSIONS)).toMatchObject({ group: 'Approvals', presets: ['TECH', 'HEAD'] });
    await h.http().get('/v1/permissions/catalogue').expect(401);
  });
});

describe('POST /v1/users/:id/permission-changes', () => {
  it('applies a decrease at once, and the next request sees it', async () => {
    const res = await changes('head', ids.exec, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }], reason }).expect(200);
    expect(res.body).toMatchObject({ applied: true, direction: 'DECREASE', lost: [P.COPILOT_USE] });
    const me = await h.http().get('/v1/auth/me').set(as('exec')).expect(200);
    expect(me.body.permissions).not.toContain(P.COPILOT_USE);
  });

  it('answers 409 approval_required for an increase, with or without a checker, and applies nothing', async () => {
    for (const body of [
      { changes: [{ op: 'GRANT', permission: P.SLA_MANAGE, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }], reason },
      { changes: [{ op: 'CLEAR', permission: P.COPILOT_USE }], reason },
      { preset: 'LEAD', reason },
      { changes: [{ op: 'GRANT', permission: P.SLA_MANAGE }], reason, approval: { checkerId: ids.head2 } },
      { changes: [{ op: 'GRANT', permission: P.SLA_MANAGE }], reason, approval: { bootstrap: true } },
    ]) {
      const res = await changes('head', ids.exec, body).expect(409);
      expect(res.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change', action: 'UPDATE', objectId: ids.exec } });
    }
    const me = await h.http().get('/v1/auth/me').set(as('exec')).expect(200);
    expect(me.body).toMatchObject({ role: 'SERVICE' });
    expect(me.body.permissions).not.toContain(P.SLA_MANAGE);
  });

  it('never lets anyone change their own access, and keeps team makers in their teams', async () => {
    await changes('head', ids.head, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }], reason }).expect(403);
    await changes('head2', ids.exec, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason }).expect(403);
    // Lead has users.manage_team but not permissions.manage.
    await changes('lead', ids.exec, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason }).expect(403);
    await changes('exec', ids.lead, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason }).expect(403);
    // users.manage (Tech) is not team-scoped.
    await changes('admin', ids.lead, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }], reason }).expect(200);
  });

  it('validates the change set', async () => {
    await changes('head', ids.exec, { changes: [], reason }).expect(400);
    await changes('head', ids.exec, { changes: [{ op: 'GRANT', permission: 'no.such' }], reason }).expect(400);
    await changes('head', ids.exec, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }, { op: 'CLEAR', permission: P.COPILOT_USE }], reason }).expect(400);
    await changes('head', ids.exec, { changes: [{ op: 'REVOKE', permission: P.COPILOT_USE }], reason: '' }).expect(400);
    await changes('head', ids.exec, { changes: [{ op: 'GRANT', permission: P.SLA_MANAGE, expiresAt: '2020-01-01T00:00:00Z' }], reason }).expect(400);
  });
});

describe('GET /v1/users/:id/permissions and /v1/auth/me', () => {
  it('shows effective permissions with sources; an approved grant reaches /v1/auth/me', async () => {
    // What approving a permission_change proposal applies (wave 2 wires the descriptor to it).
    await h.db.db.transaction(async (tx) => applyPermissionChangeSet(tx, await adminActor(), { userId: ids.exec, ops: [{ op: 'GRANT', permission: P.SLA_MANAGE, expiresAt: null }], reason }, { proposalId: uuidv7() }));
    const me = await h.http().get('/v1/auth/me').set(as('exec')).expect(200);
    expect(me.body.permissions).toContain(P.SLA_MANAGE);
    const view = await h.http().get(`/v1/users/${ids.exec}/permissions`).set(as('head')).expect(200);
    const row = (p: string) => view.body.effective.find((e: { permission: string }) => e.permission === p);
    expect(view.body).toMatchObject({ userId: ids.exec, preset: 'SERVICE', presetLabel: 'Service', status: 'ACTIVE' });
    expect(row(P.SLA_MANAGE)).toMatchObject({ active: true, sources: [{ kind: 'GRANT', expiresAt: null, grantedBy: { id: ids.admin } }] });
    expect(row(P.COPILOT_USE)).toMatchObject({ active: false, sources: [{ kind: 'PRESET' }], revoked: { revokedBy: { id: ids.head } } });
    expect(row(P.CONVERSATIONS_REPLY)).toMatchObject({ active: true, sources: [{ kind: 'PRESET', preset: 'SERVICE' }], revoked: null });
  });

  it('is scoped: permissions.read, and a shared team unless users.manage (else 404)', async () => {
    await h.http().get(`/v1/users/${ids.exec}/permissions`).set(as('head2')).expect(404);
    await h.http().get(`/v1/users/${ids.lead}/permissions`).set(as('exec')).expect(403);
    await h.http().get(`/v1/users/${ids.exec}/permissions`).set(as('lead')).expect(200);
    await h.http().get(`/v1/users/${ids.head2}/permissions`).set(as('admin')).expect(200);
  });
});

describe('users and memberships', () => {
  it('creates users PENDING_APPROVAL: they cannot sign in until activated', async () => {
    const created = await h.http().post('/v1/users').set(as('admin')).send({ email: 'new@ocso.test', name: 'New', role: 'SERVICE', password: PASSWORD }).expect(201);
    expect(created.body).toMatchObject({ status: 'PENDING_APPROVAL', onboarding: { kind: 'pending_approval' }, proposal: null, approvalRequired: { objectKind: 'user', action: 'CREATE', objectId: created.body.id } });
    // The right password gets a clear answer (no session): the account waits for approval.
    const refused = await h.http().post('/api/auth/sign-in/email').send({ email: 'new@ocso.test', password: PASSWORD }).expect(403);
    expect(JSON.stringify(refused.body)).toMatch(/ACCOUNT_PENDING_APPROVAL/);
    await h.http().post('/api/auth/sign-in/email').send({ email: 'new@ocso.test', password: 'wrong password 1234' }).expect(401);
    const list = await h.http().get('/v1/users').set(as('admin')).expect(200);
    expect(list.body.find((u: { id: string }) => u.id === created.body.id).status).toBe('PENDING_APPROVAL');
    await h.http().patch(`/v1/users/${created.body.id}`).set(as('admin')).send({ status: 'ACTIVE' }).expect(409);
    await h.http().post(`/v1/users/${created.body.id}/invite`).set(as('admin')).expect(409);
    expect((await h.http().get('/v1/users/onboarding').set(as('admin')).expect(200)).body.approvalRequired).toBe(true);
    // What approving the user does.
    await h.db.db.transaction(async (tx) => activateUser(tx, await adminActor(), created.body.id));
    await h.loginAs('new@ocso.test', PASSWORD);
  });

  it('a Head creates within their teams and rights only', async () => {
    await h.http().post('/v1/users').set(as('head')).send({ email: 'x1@ocso.test', name: 'X1', role: 'TECH', password: PASSWORD, teamIds: [ids.cards] }).expect(403);
    await h.http().post('/v1/users').set(as('head')).send({ email: 'x2@ocso.test', name: 'X2', role: 'SERVICE', password: PASSWORD, teamIds: [ids.loans] }).expect(403);
    await h.http().post('/v1/users').set(as('head')).send({ email: 'x3@ocso.test', name: 'X3', role: 'LEAD', password: PASSWORD, teamIds: [ids.cards] }).expect(201);
  });

  it('PATCH: upgrades and team additions need approval; downgrades apply', async () => {
    const upgrade = await h.http().patch(`/v1/users/${ids.lead}`).set(as('admin')).send({ role: 'HEAD' }).expect(409);
    expect(upgrade.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change', objectId: ids.lead } });
    await h.http().patch(`/v1/users/${ids.lead}`).set(as('admin')).send({ teamIds: [ids.cards, ids.loans] }).expect(409);
    await h.http().post(`/v1/teams/${ids.loans}/members`).set(as('admin')).send({ userId: ids.lead }).expect(409);
    await h.http().patch(`/v1/users/${ids.lead}`).set(as('admin')).send({ role: 'SERVICE' }).expect(200);
    await h.http().delete(`/v1/teams/${ids.cards}/members/${ids.lead}`).set(as('admin')).expect(204);
    expect((await h.http().get(`/v1/users/${ids.lead}/permissions`).set(as('admin')).expect(200)).body.preset).toBe('SERVICE');
  });
});

describe('review hardening over HTTP', () => {
  it('applies the reductions in a mixed change and says so in the 409', async () => {
    const res = await changes('head', ids.exec, { changes: [{ op: 'REVOKE', permission: P.CONVERSATIONS_NOTE }, { op: 'GRANT', permission: P.EVALUATIONS_RUN }], reason }).expect(409);
    expect(res.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'permission_change', applied: { lost: [P.CONVERSATIONS_NOTE] } } });
    const me = await h.http().get('/v1/auth/me').set(as('exec')).expect(200);
    expect(me.body.permissions).not.toContain(P.CONVERSATIONS_NOTE);
    expect(me.body.permissions).not.toContain(P.EVALUATIONS_RUN);
  });

  it('refuses grants a preset can never hold (400), whatever the approval', async () => {
    const tech2 = await addUserWithPassword(h, { email: 'tech2@ocso.test', name: 'Tech Two', role: 'TECH', password: PASSWORD });
    const res = await changes('admin', tech2, { changes: [{ op: 'GRANT', permission: P.CONVERSATIONS_READ }], reason, approval: { checkerId: ids.head } }).expect(400);
    expect(res.body.error.code).toBe('grant_not_allowed_for_preset');
  });

  it('submits a pending user with PATCH, refuses disabling it, and discards it (DELETE) to free the email', async () => {
    const created = await h.http().post('/v1/users').set(as('admin')).send({ email: 'draft@ocso.test', name: 'Draft', role: 'SERVICE', password: PASSWORD }).expect(201);
    const submit = await h.http().patch(`/v1/users/${created.body.id}`).set(as('admin')).send({ approval: { checkerId: ids.head } }).expect(409);
    expect(submit.body.error).toMatchObject({ code: 'approval_required', details: { objectKind: 'user', action: 'CREATE', objectId: created.body.id } });
    await h.http().patch(`/v1/users/${created.body.id}`).set(as('admin')).send({ status: 'DISABLED' }).expect(409);
    await h.http().delete(`/v1/users/${created.body.id}`).set(as('exec')).expect(403);
    await h.http().delete(`/v1/users/${ids.exec}`).set(as('admin')).expect(409);
    await h.http().delete(`/v1/users/${created.body.id}`).set(as('admin')).expect(204);
    await h.http().post('/v1/users').set(as('admin')).send({ email: 'draft@ocso.test', name: 'Draft Again', role: 'SERVICE', password: PASSWORD }).expect(201);
  });

  it('requires MFA of someone granted a permission only an MFA-required preset holds', async () => {
    const plain = await addUserWithPassword(h, { email: 'plain@ocso.test', name: 'Plain', role: 'SERVICE', password: PASSWORD });
    const token = { authorization: `Bearer ${await h.loginAs('plain@ocso.test', PASSWORD)}` };
    await h.http().put('/v1/settings/auth-policy').set(as('admin')).send({ requireMfaRoles: ['HEAD'] }).expect(200);
    await h.http().get('/v1/permissions/catalogue').set(token).expect(200);
    await h.db.db.transaction(async (tx) => applyPermissionChangeSet(tx, await adminActor(), { userId: plain, ops: [{ op: 'GRANT', permission: P.EXCEPTIONS_SIGN, expiresAt: null }], reason }, { proposalId: uuidv7() }));
    const blocked = await h.http().get('/v1/permissions/catalogue').set(token).expect(403);
    expect(blocked.body.error.code).toBe('mfa_enrollment_required');
    await h.http().put('/v1/settings/auth-policy').set(as('admin')).send({ requireMfaRoles: [] }).expect(200);
  });
});
