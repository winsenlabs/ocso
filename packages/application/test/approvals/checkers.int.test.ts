import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { approvalProposals, outboxEvents, users } from '@ocso/db';
import { revalidateCheckers, systemActor } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** Who may check, self-review, bootstrap, the checker sweep and reassignment (PM/research/11 §4.2–4.3, 11b). */
let f: ApprovalFixture;
beforeAll(async () => {
  f = await createApprovalFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

describe('eligibility', () => {
  it('lists Heads of the object’s teams, never the maker, never another team or a Lead', async () => {
    const choice = await f.approvals.checkerCandidates(f.p.lead, 'agent', f.maya);
    expect(choice.checkers.map((c) => c.name).sort()).toEqual(['Anjali Rao', 'Priya Nair']);
    expect(choice.bootstrapAllowed).toBe(false);
    const asHead = await f.approvals.checkerCandidates(f.p.head, 'agent', f.maya);
    expect(asHead.checkers.map((c) => c.name)).toEqual(['Priya Nair']);
  });

  it('refuses a checker who is not eligible: yourself, a Lead, another team’s Head', async () => {
    for (const checker of [f.p.lead, f.p.service, f.p.headLoans, f.p.tech]) {
      await expect(f.submit(f.p.lead, checker, { action: 'ACTIVATE' })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    }
    await expect(f.submit(f.p.head, f.p.head, { action: 'ACTIVATE' })).rejects.toMatchObject({ code: 'checker_not_eligible' });
  });

  it('the database refuses maker = checker outside a bootstrap', async () => {
    const insert = f.t.db.execute(sql`INSERT INTO approval_proposals (id, object_kind, object_id, action, content_hash, dependency_hash, title, reason, maker_id, checker_id)
      VALUES (gen_random_uuid(), 'agent', ${f.maya}, 'UPDATE', 'ap_x', 'ad_x', 't', 'r', ${f.p.head.userId}, ${f.p.head.userId})`);
    await expect(insert).rejects.toMatchObject({ cause: { constraint: 'approval_proposals_self_ck' } });
  });
});

describe('bootstrap approval', () => {
  it('is refused while another eligible checker exists', async () => {
    await expect(f.approvals.submit(act(f.p.head), { objectKind: 'agent', objectId: f.maya, action: 'ACTIVATE', bootstrap: true, reason: 'Alone' })).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
  });

  it('is refused to a maker without the check permission', async () => {
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, f.p.head2.userId));
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, f.p.head.userId));
    await expect(f.approvals.submit(act(f.p.lead), { objectKind: 'agent', objectId: f.maya, action: 'ACTIVATE', bootstrap: true, reason: 'Alone' })).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
    await f.t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, f.p.head.userId));
  });

  it('with nobody in the owning teams, a Head of another team is the fallback checker — bootstrap stays refused', async () => {
    // Cards' other Head is disabled: the platform-wide fallback makes Loans' Head eligible, so a second person
    // still checks (reshaping a team can never manufacture a self-approval).
    const choice = await f.approvals.checkerCandidates(f.p.head, 'agent', f.maya);
    expect(choice.checkers.map((c) => c.name)).toEqual(['Rohan Kapoor']);
    expect(choice.bootstrapAllowed).toBe(false);
    await expect(f.approvals.submit(act(f.p.head), { objectKind: 'agent', objectId: f.maya, action: 'ACTIVATE', bootstrap: true, reason: 'Alone' })).rejects.toMatchObject({ code: 'bootstrap_not_allowed' });
    // The fallback checker decides from the proposal (not the object, which they cannot read) and it goes through.
    const other = await f.newAgent('Fallback Fay');
    const proposal = await f.submit(f.p.head, f.p.headLoans, { objectId: other, action: 'ACTIVATE' });
    expect((await f.approvals.list(f.p.headLoans, { box: 'AWAITING_ME', limit: 10 })).rows.map((r) => r.id)).toEqual([proposal.id]);
    await expect(f.approve(f.p.headLoans, proposal.id)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('with no one else eligible anywhere, a Head approves their own change — recorded as BOOTSTRAP_APPROVE', async () => {
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, f.p.headLoans.userId));
    expect((await f.approvals.checkerCandidates(f.p.head, 'agent', f.maya)).bootstrapAllowed).toBe(true);
    const proposal = await f.approvals.submit(act(f.p.head), { objectKind: 'agent', objectId: f.maya, action: 'ACTIVATE', bootstrap: true, reason: 'Sole Head of Cards' });
    expect(proposal).toMatchObject({ status: 'APPROVED', bootstrap: true, maker: { id: f.p.head.userId }, checker: { id: f.p.head.userId } });
    expect(proposal.decisions.map((d) => d.kind)).toEqual(['SUBMIT', 'BOOTSTRAP_APPROVE', 'ACTIVATE']);
    await f.t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, f.p.head2.userId));
    await f.t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, f.p.headLoans.userId));
  });
});

describe('checker lifecycle', () => {
  it('a disabled checker is flagged by the sweep (never reassigned), cannot decide, and a new checker can be named', async () => {
    const proposal = await f.submit(f.p.lead, f.p.head2, { action: 'UPDATE', payload: { purpose: 'needs checking' } });
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, f.p.head2.userId));
    const swept = await revalidateCheckers(f.t.db, f.registry, { publish: async () => {} }, systemActor('test', 'c'));
    expect(swept.invalidated).toBe(1);
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, proposal.id));
    expect(row).toMatchObject({ checkerValid: false, checkerId: f.p.head2.userId });
    const events = await f.t.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'approval.checker_invalid'));
    expect(events.map((e) => (e.payload as { reason: string }).reason)).toContain('DISABLED');
    expect((await f.approvals.counts(f.p.tech)).needsChecker).toBe(1);

    // A decision re-reads rights: the disabled checker's still-held principal cannot approve; nor can anyone else.
    const shown = await f.approvals.get(f.p.head, proposal.id);
    expect(shown.warnings.map((w) => w.code)).toContain('checker_invalid');
    await expect(f.decisions.decide(act(f.p.head2), proposal.id, { decision: 'APPROVE', contentHash: shown.contentHash })).rejects.toMatchObject({ category: 'authorization', code: 'forbidden' });
    await expect(f.decisions.decide(act(f.p.head), proposal.id, { decision: 'APPROVE', contentHash: shown.contentHash })).rejects.toMatchObject({ code: 'not_checker' });

    // Reassigning to a Lead (no check permission) is refused; to an eligible Head it works, by Tech (reassign_any).
    await expect(f.decisions.reassign(act(f.p.tech), proposal.id, { checkerId: f.p.lead.userId, reason: 'Covering' })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    const reassigned = await f.decisions.reassign(act(f.p.tech), proposal.id, { checkerId: f.p.head.userId, reason: 'Priya left' });
    expect(reassigned).toMatchObject({ checker: { id: f.p.head.userId }, checkerValid: true });
    expect(reassigned.decisions.map((d) => d.kind)).toContain('REASSIGN');
    await expect(f.approve(f.p.head, proposal.id)).resolves.toMatchObject({ status: 'APPROVED' });
    await f.t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, f.p.head2.userId));
  });

  it('reassigning to the maker is refused (self-review)', async () => {
    const proposal = await f.submit(f.p.head, f.p.head2, { action: 'UPDATE', payload: { purpose: 'by a head' } });
    await expect(f.decisions.reassign(act(f.p.head2), proposal.id, { checkerId: f.p.head.userId, reason: 'Swap' })).rejects.toMatchObject({ code: 'checker_not_eligible' });
    await expect(f.decisions.decide(act(f.p.head), proposal.id, { decision: 'APPROVE', contentHash: proposal.contentHash })).rejects.toMatchObject({ code: 'self_review' });
    await expect(f.decisions.decide(act(f.p.tech), proposal.id, { decision: 'APPROVE', contentHash: proposal.contentHash })).rejects.toMatchObject({ category: expect.stringMatching(/authorization|not_found/) });
    await f.approvals.withdraw(act(f.p.head), proposal.id, 'done');
  });
});

describe('scoping', () => {
  it('another team’s Head neither lists nor opens the proposal; Tech (reassign_any) sees all open ones', async () => {
    const proposal = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'scoped' } });
    expect((await f.approvals.list(f.p.headLoans, { box: 'SENT_BY_ME', limit: 100 })).rows).toHaveLength(0);
    expect((await f.approvals.list(f.p.headLoans, { box: 'DECIDED', limit: 100 })).rows.map((r) => r.id)).not.toContain(proposal.id);
    await expect(f.approvals.get(f.p.headLoans, proposal.id)).rejects.toMatchObject({ category: 'not_found' });
    expect((await f.approvals.list(f.p.tech, { box: 'OPEN', limit: 50 })).rows.map((r) => r.id)).toContain(proposal.id);
    await expect(f.approvals.list(f.p.head, { box: 'OPEN', limit: 50 })).rejects.toMatchObject({ category: 'authorization' });
    // A Service member of the team sees it (team scope) but can do nothing with it.
    const seen = await f.approvals.get(f.p.service, proposal.id);
    expect(seen).toMatchObject({ canDecide: false, canEdit: false, canReassign: false });
    expect((await f.approvals.list(f.p.service, { box: 'AWAITING_ME', limit: 50 })).rows).toHaveLength(0);
  });
});
