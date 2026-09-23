import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { Permission as P } from '@ocso/auth';
import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { approvalProposals, userPermissionGrants, users } from '@ocso/db';
import type { EmailMessage, EmailSender } from '@ocso/email';
import {
  ApprovalDecisionService,
  ApprovalService,
  AuthMailer,
  PermissionService,
  UserService,
  createApprovalRegistry,
  identityGovernanceWith,
  loadPrincipal,
  systemActor,
  type ApprovalRegistry,
} from '../../src/index.js';
import { actorOf, addPerson, addTeam, principalOf } from '../support/identity-fixture.js';

/**
 * user and permission_change (PM/research/11 §3.4, §4): PERMS' increases become
 * proposals through the IDENTITY_APPROVALS adapter; approval applies them. The
 * checker holds approvals.check.permissions and is never the maker nor the
 * person whose access changes; bootstrap only when nobody else anywhere can check.
 */
let t: TestDatabase;
let registry: ApprovalRegistry;
let approvals: ApprovalService;
let decisions: ApprovalDecisionService;
const sent: EmailMessage[] = [];
const sender: EmailSender = { driver: 'test', from: 'ocso@bank.test', send: async (m) => (sent.push(m), { id: null }) };
const ids = { tech: '', headCards: '', headCards2: '', headLoans: '', lead: '', service: '', cards: '', loans: '' };
const reason = 'identity approvals test';

const governance = () => identityGovernanceWith(approvals);
const permissions = () => new PermissionService(t.db, governance());
const usersService = (mailer?: AuthMailer) => new UserService(t.db, { ...governance(), mailer: mailer ?? new AuthMailer({ db: t.db, sender, publicUrl: 'https://ocso.bank.test' }) });
const approve = async (checkerId: string, proposalId: string) => {
  const checker = await principalOf(t.db, checkerId);
  const shown = await approvals.get(checker, proposalId);
  return decisions.decide({ principal: checker, correlationId: 'identity-test' }, proposalId, { decision: 'APPROVE', reason: 'Checked', contentHash: shown.contentHash });
};
const has = async (userId: string, permission: P) => Boolean((await loadPrincipal(t.db, userId, 'UI'))?.permissions?.has(permission));

beforeAll(async () => {
  t = await createTestDatabase();
  const mailer = new AuthMailer({ db: t.db, sender, publicUrl: 'https://ocso.bank.test' });
  registry = createApprovalRegistry({ business: { authMailer: mailer } });
  approvals = new ApprovalService(t.db, registry);
  decisions = new ApprovalDecisionService(t.db, registry);
  ids.cards = await addTeam(t.db, 'Cards');
  ids.loans = await addTeam(t.db, 'Loans');
  ids.tech = await addPerson(t.db, { name: 'Tara Tech', role: 'TECH', password: true });
  ids.headCards = await addPerson(t.db, { name: 'Hana Head', role: 'HEAD', teamIds: [ids.cards] });
  ids.headCards2 = await addPerson(t.db, { name: 'Priya Head', role: 'HEAD', teamIds: [ids.cards] });
  ids.headLoans = await addPerson(t.db, { name: 'Omar Head', role: 'HEAD', teamIds: [ids.loans] });
  ids.lead = await addPerson(t.db, { name: 'Leo Lead', role: 'LEAD', teamIds: [ids.cards] });
  ids.service = await addPerson(t.db, { name: 'Esha Service', role: 'SERVICE', teamIds: [ids.cards] });
});
afterAll(async () => {
  await t?.drop();
});

describe('permission changes', () => {
  it('an increase becomes a proposal; the approval applies it (recorded against the proposal)', async () => {
    const result = await permissions().change(await actorOf(t.db, ids.headCards), ids.service, {
      changes: [{ op: 'GRANT', permission: P.CUSTOMERS_MANAGE, expiresAt: null }],
      reason,
      approval: { checkerId: ids.headCards2 },
    });
    expect(result.proposal).toMatchObject({ objectKind: 'permission_change', status: 'SUBMITTED', checkerId: ids.headCards2 });
    expect(await has(ids.service, P.CUSTOMERS_MANAGE)).toBe(false);
    const detail = await approvals.get(await principalOf(t.db, ids.headCards2), result.proposal!.id);
    expect(detail.title).toMatch(/Esha Service's access/);
    expect(detail.after).toMatchObject({ grants: { [P.CUSTOMERS_MANAGE]: 'no expiry' }, newAccess: [P.CUSTOMERS_MANAGE] });
    await approve(ids.headCards2, result.proposal!.id);
    expect(await has(ids.service, P.CUSTOMERS_MANAGE)).toBe(true);
    const [grant] = await t.db.select().from(userPermissionGrants).where(and(eq(userPermissionGrants.userId, ids.service), eq(userPermissionGrants.permission, P.CUSTOMERS_MANAGE)));
    expect(grant).toMatchObject({ proposalId: result.proposal!.id, createdBy: ids.headCards });
    // Nothing granted is live without an approval.
    expect(await registry.get('permission_change').liveObjects(t.db)).toEqual([]);
  });

  it('the checker is never the maker nor the person whose access changes', async () => {
    const head = await actorOf(t.db, ids.headCards);
    // Upgrading Priya (a Head) — she holds the check permission but may not check her own upgrade.
    await expect(
      approvals.submit(head, { objectKind: 'permission_change', objectId: ids.headCards2, action: 'UPDATE', checkerId: ids.headCards2, reason, payload: { userId: ids.headCards2, makerId: ids.headCards, ops: [{ op: 'GRANT', permission: P.AUDIT_READ_ALL, expiresAt: null }], reason } }),
    ).rejects.toMatchObject({ code: 'checker_not_eligible' });
    await expect(
      approvals.submit(head, { objectKind: 'permission_change', objectId: ids.service, action: 'UPDATE', checkerId: ids.headCards, reason, payload: { userId: ids.service, makerId: ids.headCards, ops: [{ op: 'GRANT', permission: P.COPILOT_USE, expiresAt: null }], reason } }),
    ).rejects.toMatchObject({ code: 'checker_not_eligible' });
    // Candidates the maker is offered: a teammate of the target with the check permission, or users.manage — never the target.
    const choice = await approvals.checkerCandidates(await principalOf(t.db, ids.headCards), 'permission_change', ids.headCards2);
    expect(choice.checkers.map((c) => c.id).sort()).toEqual([ids.tech].sort());
    expect(choice.bootstrapAllowed).toBe(false);
  });

  it('a reduction applies at once while an increase waits; the waiting one then needs a refresh', async () => {
    const lead = await actorOf(t.db, ids.headCards);
    const up = await permissions().change(lead, ids.lead, { changes: [{ op: 'GRANT', permission: P.REVIEWS_MANAGE, expiresAt: null }], reason, approval: { checkerId: ids.headCards2 } });
    // Stop: a revoke of something else, never locked by the open proposal.
    const down = await permissions().change(lead, ids.lead, { changes: [{ op: 'REVOKE', permission: P.EVALUATIONS_RUN }], reason });
    expect(down).toMatchObject({ applied: true, direction: 'DECREASE' });
    await expect(approve(ids.headCards2, up.proposal!.id)).rejects.toMatchObject({ code: 'content_changed' });
  });
});

describe('users', () => {
  it('creating a user is a proposal; approval activates them and the worker sends the invite once', async () => {
    const created = await usersService().create(await actorOf(t.db, ids.headCards), {
      email: 'new.lead@bank.test',
      name: 'New Lead',
      role: 'LEAD',
      teamIds: [ids.cards],
      approval: { checkerId: ids.headCards2, reason: 'New Cards lead' },
    });
    expect(created).toMatchObject({ status: 'PENDING_APPROVAL', proposal: { objectKind: 'user', action: 'CREATE' } });
    // The pending user is a draft whose creation waits: editing it now is refused; approve what was proposed.
    await expect(usersService().update(await actorOf(t.db, ids.headCards), created.id, { role: 'SERVICE' })).rejects.toMatchObject({ code: 'approval_open' });
    const approved = await approve(ids.headCards2, created.proposal!.id);
    expect(approved).toMatchObject({ status: 'APPROVED', activating: true });
    const [row] = await t.db.select().from(users).where(eq(users.id, created.id));
    expect(row!.status).toBe('ACTIVE');
    expect(sent.filter((m) => m.to === 'new.lead@bank.test')).toHaveLength(0);
    const worker = systemActor('approval-activation', 'identity-test', 'Approval activation');
    expect(await decisions.finishActivation(worker, created.proposal!.id)).toBe('ACTIVATED');
    expect(await decisions.finishActivation(worker, created.proposal!.id)).toBe('SKIPPED');
    expect(sent.filter((m) => m.to === 'new.lead@bank.test')).toHaveLength(1);
  });

  it('discarding a pending user voids its open proposal', async () => {
    const created = await usersService().create(await actorOf(t.db, ids.headCards), {
      email: 'typo@bank.test',
      name: 'Typo',
      role: 'SERVICE',
      teamIds: [ids.cards],
      approval: { checkerId: ids.headCards2, reason: 'Oops' },
    });
    await usersService().discard(await actorOf(t.db, ids.headCards), created.id);
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, created.proposal!.id));
    expect(p!.status).toBe('VOID');
  });

  it('live objects: active users (pending drafts are not live)', async () => {
    const draft = await usersService().create(await actorOf(t.db, ids.headCards), { email: 'draft@bank.test', name: 'Draft Person', role: 'SERVICE', teamIds: [ids.cards] });
    const live = await registry.get('user').liveObjects(t.db);
    // People written straight to the database (like pre-0031 users) are live: 0031 grandfathers exactly these.
    expect(live).toContain(ids.tech);
    expect(live).not.toContain(draft.id);
  });
});

describe('bootstrap', () => {
  it('only when nobody else anywhere can check (the target never counts), and never once someone can', async () => {
    const solo = await createTestDatabase();
    try {
      const soloRegistry = createApprovalRegistry();
      const soloApprovals = new ApprovalService(solo.db, soloRegistry);
      const team = await addTeam(solo.db, 'Ops');
      const tech = await addPerson(solo.db, { name: 'Only Tech', role: 'TECH', password: true });
      const head = await addPerson(solo.db, { name: 'First Head', role: 'HEAD', teamIds: [team] });
      const gov = identityGovernanceWith(soloApprovals);
      const perms = new PermissionService(solo.db, gov);
      // The Head holds the check permission but is the target: the Tech may bootstrap.
      const choice = await soloApprovals.checkerCandidates(await principalOf(solo.db, tech), 'permission_change', head);
      expect(choice).toMatchObject({ checkers: [], bootstrapAllowed: true });
      const boot = await perms.change(await actorOf(solo.db, tech), head, { changes: [{ op: 'GRANT', permission: P.AUDIT_READ_ALL, expiresAt: null }], reason, approval: { bootstrap: true } });
      expect(boot.proposal).toMatchObject({ bootstrap: true, status: 'APPROVED' });
      expect(Boolean((await loadPrincipal(solo.db, head, 'UI'))?.permissions?.has(P.AUDIT_READ_ALL))).toBe(true);
      // A second Head now exists: the Tech names a checker, bootstrap is refused.
      const service = await addPerson(solo.db, { name: 'Sam Service', role: 'SERVICE', teamIds: [team] });
      await expect(
        perms.change(await actorOf(solo.db, tech), service, { changes: [{ op: 'GRANT', permission: P.CUSTOMERS_MANAGE, expiresAt: null }], reason, approval: { bootstrap: true } }),
      ).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
    } finally {
      await solo.drop();
    }
  });

  it('the platform-wide fallback: a Head of another team checks when the target’s team has no other checker', async () => {
    // Loans has one Head (Omar). Upgrading a Loans Service member by Omar: Tech (users.manage) is the primary checker.
    const loansService = await addPerson(t.db, { name: 'Lina Loans', role: 'SERVICE', teamIds: [ids.loans] });
    const choice = await approvals.checkerCandidates(await principalOf(t.db, ids.headLoans), 'permission_change', loansService);
    expect(choice.checkers.map((c) => c.id)).toEqual([ids.tech]);
  });
});

describe('review fixes', () => {
  const worker = systemActor('approval-activation', 'identity-test', 'Approval activation');

  it('shortening an approved grant carries its approval: no permission bypass is reported', async () => {
    const head = await actorOf(t.db, ids.headCards);
    const up = await permissions().change(head, ids.service, { changes: [{ op: 'GRANT', permission: P.CONVERSATIONS_ASSIGN, expiresAt: null }], reason, approval: { checkerId: ids.headCards2 } });
    await approve(ids.headCards2, up.proposal!.id);
    const soon = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const down = await permissions().change(head, ids.service, { changes: [{ op: 'GRANT', permission: P.CONVERSATIONS_ASSIGN, expiresAt: soon }], reason });
    expect(down).toMatchObject({ applied: true });
    const [grant] = await t.db
      .select()
      .from(userPermissionGrants)
      .where(and(eq(userPermissionGrants.userId, ids.service), eq(userPermissionGrants.permission, P.CONVERSATIONS_ASSIGN), isNull(userPermissionGrants.clearedAt)));
    expect(grant).toMatchObject({ proposalId: up.proposal!.id });
    expect(await registry.get('permission_change').liveObjects(t.db)).not.toContain(ids.service);
  });

  it('an approved new user stays approved when their rights shrink before the invite goes', async () => {
    const created = await usersService().create(await actorOf(t.db, ids.tech), { email: 'shrink@bank.test', name: 'Shrink Me', role: 'LEAD', teamIds: [ids.cards, ids.loans], approval: { checkerId: ids.headCards2, reason: 'New lead' } });
    await approve(ids.headCards2, created.proposal!.id);
    // A reduction (leave a team) before the worker ran.
    await usersService().update(await actorOf(t.db, ids.tech), created.id, { teamIds: [ids.cards] });
    expect(await decisions.finishActivation(worker, created.proposal!.id)).toBe('ACTIVATED');
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, created.proposal!.id));
    expect(p).toMatchObject({ status: 'APPROVED' });
    expect(p!.activatedAt).not.toBeNull();
  });

  it('an invite that keeps failing is recorded on the activation, never a BLOCKED user proposal', async () => {
    const failing: EmailSender = { driver: 'test', from: 'ocso@bank.test', send: async () => Promise.reject(new Error('SMTP down')) };
    const failingRegistry = createApprovalRegistry({ business: { authMailer: new AuthMailer({ db: t.db, sender: failing, publicUrl: 'https://ocso.bank.test' }) } });
    const failingDecisions = new ApprovalDecisionService(t.db, failingRegistry);
    const created = await usersService().create(await actorOf(t.db, ids.headCards), { email: 'nomail@bank.test', name: 'No Mail', role: 'SERVICE', teamIds: [ids.cards], approval: { checkerId: ids.headCards2, reason: 'New agent' } });
    await approve(ids.headCards2, created.proposal!.id);
    let outcome: string | null = null;
    for (let i = 0; i < 6 && outcome === null; i++) outcome = await failingDecisions.finishActivation(worker, created.proposal!.id).catch(() => null);
    expect(outcome).toBe('ACTIVATED');
    const [p] = await t.db.select().from(approvalProposals).where(eq(approvalProposals.id, created.proposal!.id));
    expect(p!.status).toBe('APPROVED');
  });
});

describe('bootstrap after disabling the other checkers', () => {
  it('is refused while a checker was disabled recently; re-enabling a checker alone may be self-approved', async () => {
    const solo = await createTestDatabase();
    try {
      const soloRegistry = createApprovalRegistry();
      const soloApprovals = new ApprovalService(solo.db, soloRegistry);
      const team = await addTeam(solo.db, 'Ops');
      const tech = await addPerson(solo.db, { name: 'Tess Tech', role: 'TECH', password: true });
      const h1 = await addPerson(solo.db, { name: 'Hari Head', role: 'HEAD', teamIds: [team] });
      const h2 = await addPerson(solo.db, { name: 'Hema Head', role: 'HEAD', teamIds: [team] });
      const service = await addPerson(solo.db, { name: 'Sid Service', role: 'SERVICE', teamIds: [team] });
      const gov = identityGovernanceWith(soloApprovals);
      const soloUsers = new UserService(solo.db, { ...gov });
      const actor = await actorOf(solo.db, tech);
      // Disabling is a stop: immediate.
      await soloUsers.update(actor, h1, { status: 'DISABLED' });
      await soloUsers.update(actor, h2, { status: 'DISABLED' });
      // Nobody else ACTIVE can check now, but that is only because the Tech just disabled them.
      const perms = new PermissionService(solo.db, gov);
      await expect(
        perms.change(actor, service, { changes: [{ op: 'GRANT', permission: P.CONVERSATIONS_ASSIGN, expiresAt: null }], reason, approval: { bootstrap: true } }),
      ).rejects.toMatchObject({ code: 'validation_failed', details: { problems: expect.arrayContaining([expect.objectContaining({ code: 'bootstrap_checker_disabled' })]) } });
      // Bringing a checker back is the way out, and may be self-approved.
      const back = await soloApprovals.submit(actor, { objectKind: 'user', objectId: h1, action: 'ACTIVATE', bootstrap: true, reason: 'Back from leave' });
      expect(back).toMatchObject({ status: 'APPROVED', bootstrap: true });
      // From then on the re-enabled Head checks.
      await expect(
        perms.change(actor, service, { changes: [{ op: 'GRANT', permission: P.CUSTOMERS_MANAGE, expiresAt: null }], reason, approval: { bootstrap: true } }),
      ).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
    } finally {
      await solo.drop();
    }
  });
});
