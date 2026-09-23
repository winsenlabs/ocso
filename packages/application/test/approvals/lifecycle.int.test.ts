import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { approvalProposals, outboxEvents, users } from '@ocso/db';
import { LogEmailSender } from '@ocso/email';
import { ApprovalNotifier, redispatchActivations, redispatchApprovalNotices, systemActor, voidOrphanProposals } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** Notifications and the leader sweeps of the approval spine (PM/research/11b). */
let f: ApprovalFixture;
let email: LogEmailSender;
let notifier: ApprovalNotifier;
beforeAll(async () => {
  f = await createApprovalFixture();
  email = new LogEmailSender('ocso@bank.test');
  notifier = new ApprovalNotifier({ db: f.t.db, registry: f.registry, email, baseUrl: 'https://ocso.bank.test/' });
});
afterAll(async () => {
  await f?.t.drop();
});

const to = (address: string) => email.sent.filter((m) => [m.to].flat().includes(address)).map((m) => m.subject);

describe('notifications', () => {
  it('emails the checker once, stamps notified_at, and tells the maker the outcome', async () => {
    const p = await f.submit(f.p.lead, f.p.head, { action: 'ACTIVATE' });
    expect(await notifier.handle({ proposalId: p.id, kind: 'REQUESTED' })).toBe('sent');
    expect(await notifier.handle({ proposalId: p.id, kind: 'REQUESTED' })).toBe('skipped');
    expect(to('anjali@bank.test')).toEqual(['[OCSO] Approval needed: Take Maya live']);
    expect(email.sent[0]!.text).toContain(`https://ocso.bank.test/approvals?approval=${p.id}`);
    const [row] = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(row!.notifiedAt).not.toBeNull();
    // The realtime side is written with the proposal: approval.requested in the outbox.
    const events = await f.t.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'approval.requested'));
    expect(events.map((e) => (e.payload as { proposalId: string }).proposalId)).toContain(p.id);

    await f.approve(f.p.head, p.id);
    expect(await notifier.handle({ proposalId: p.id, kind: 'DECIDED' })).toBe('sent');
    expect(to('lena@bank.test')).toEqual(['[OCSO] Approved: Take Maya live']);
  });

  it('tells Tech (reassign_any) and the maker when the checker can no longer act', async () => {
    const p = await f.submit(f.p.lead, f.p.head2, { action: 'UPDATE', payload: { purpose: 'x' } });
    await f.t.db.update(approvalProposals).set({ checkerValid: false }).where(eq(approvalProposals.id, p.id));
    expect(await notifier.handle({ proposalId: p.id, kind: 'CHECKER_INVALID' })).toBe('sent');
    expect(to('tarun@bank.test')).toContain('[OCSO] Needs a new checker: Change Maya: purpose');
    expect(to('lena@bank.test')).toContain('[OCSO] Needs a new checker: Change Maya: purpose');
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
  });
});

describe('sweeps', () => {
  it('re-publishes notices nobody sent and deferred activations nobody finished', async () => {
    const p = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'redispatch me' } });
    const published: Array<{ topic: string; payload: unknown }> = [];
    const queue = { publish: async (topic: string, payload: unknown) => void published.push({ topic, payload }) };
    expect(await redispatchApprovalNotices(f.t.db, queue)).toBe(0);
    expect(await redispatchApprovalNotices(f.t.db, queue, new Date(Date.now() + 120_000))).toBe(1);
    expect(published).toEqual([{ topic: 'approval.notify', payload: { proposalId: p.id, kind: 'REQUESTED' } }]);
    expect(await redispatchActivations(f.t.db, queue, new Date(Date.now() + 600_000))).toBe(0);
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
  });

  it('voids open proposals whose object is gone', async () => {
    const doomed = await f.newAgent('Gone');
    const p = await f.submit(f.p.lead, f.p.head, { objectId: doomed, action: 'ACTIVATE' });
    // Removed behind the application's back (prompt versions only go with an APPROVED DELETE, so the guard is lifted here).
    await f.t.db.transaction(async (tx) => {
      await tx.execute(sql`ALTER TABLE prompt_versions DISABLE TRIGGER prompt_versions_immutable`);
      await tx.execute(sql`DELETE FROM virtual_agents WHERE id = ${doomed}`);
      await tx.execute(sql`ALTER TABLE prompt_versions ENABLE TRIGGER prompt_versions_immutable`);
    });
    expect(await voidOrphanProposals(f.t.db, f.registry, systemActor('sweep', 'c'))).toBe(1);
    const detail = await f.approvals.get(f.p.lead, p.id);
    expect(detail).toMatchObject({ status: 'VOID' });
    expect(detail.decisions.map((d) => d.kind)).toEqual(['SUBMIT', 'VOID']);
  });

  it('does not email a disabled checker', async () => {
    const other = await f.newAgent('Quiet');
    const p = await f.submit(f.p.lead, f.p.head2, { objectId: other, action: 'ACTIVATE' });
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, f.p.head2.userId));
    expect(await notifier.handle({ proposalId: p.id, kind: 'REQUESTED' })).toBe('skipped');
    // Stamped, so the redispatch sweep stops re-publishing it every five minutes.
    const [row] = await f.t.db.select({ notifiedAt: approvalProposals.notifiedAt }).from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(row!.notifiedAt).not.toBeNull();
    await f.t.db.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, f.p.head2.userId));
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
  });

  it('a reassignment racing the email job still gets the new checker emailed', async () => {
    const other = await f.newAgent('Raced Ria');
    const p = await f.submit(f.p.lead, f.p.head, { objectId: other, action: 'ACTIVATE' });
    // The first job's email goes out to Anjali while Tech reassigns the proposal to Priya.
    const racing = new LogEmailSender('ocso@bank.test');
    const send = racing.send.bind(racing);
    racing.send = async (m) => {
      await f.decisions.reassign(act(f.p.tech), p.id, { checkerId: f.p.head2.userId, reason: 'Anjali is away' });
      return send(m);
    };
    const first = new ApprovalNotifier({ db: f.t.db, registry: f.registry, email: racing });
    expect(await first.handle({ proposalId: p.id, kind: 'REQUESTED' })).toBe('sent');
    const [row] = await f.t.db.select({ notifiedAt: approvalProposals.notifiedAt }).from(approvalProposals).where(eq(approvalProposals.id, p.id));
    expect(row!.notifiedAt).toBeNull();
    expect(await notifier.handle({ proposalId: p.id, kind: 'REQUESTED' })).toBe('sent');
    expect(to('priya@bank.test')).toContain('[OCSO] Approval needed: Take Raced Ria live');
  });
});
