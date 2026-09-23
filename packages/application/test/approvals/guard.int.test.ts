import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalProposals, virtualAgents } from '@ocso/db';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** One open proposal per object, and the object locked while it is open (PM/research/11b). */
let f: ApprovalFixture;
let other: string;
beforeAll(async () => {
  f = await createApprovalFixture();
  other = await f.newAgent('Arjun');
  // Maya goes live (approved): from now on every change to her is a proposal.
  await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { action: 'ACTIVATE' })).id);
});
afterAll(async () => {
  await f?.t.drop();
});

describe('one open proposal per object', () => {
  it('a second submit for the same object is 409 approval_open; another object is fine', async () => {
    const first = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'first' } });
    await expect(f.submit(f.p.lead, f.p.head2, { action: 'UPDATE', payload: { purpose: 'second' } })).rejects.toMatchObject({ code: 'approval_open', details: { proposalId: first.id } });
    await expect(f.submit(f.p.lead, f.p.head, { objectId: other, action: 'ACTIVATE' })).resolves.toMatchObject({ status: 'SUBMITTED' });
    const shown = await f.approvals.get(f.p.head, first.id);
    await f.decisions.decide(act(f.p.head), first.id, { decision: 'REJECT', reason: 'Not this', contentHash: shown.contentHash });
    await expect(f.submit(f.p.lead, f.p.head2, { action: 'UPDATE', payload: { purpose: 'second' } })).resolves.toMatchObject({ status: 'SUBMITTED' });
  });

  it('concurrent submits for one object: exactly one wins', async () => {
    const third = await f.newAgent('Kiran');
    const results = await Promise.allSettled([
      f.submit(f.p.lead, f.p.head, { objectId: third, action: 'ACTIVATE' }),
      f.submit(f.p.lead, f.p.head2, { objectId: third, action: 'ACTIVATE' }),
      f.submit(f.p.head, f.p.head2, { objectId: third, action: 'ACTIVATE' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.every((r) => (r.reason as { code?: string }).code === 'approval_open')).toBe(true);
    const open = await f.t.db.select().from(approvalProposals).where(eq(approvalProposals.objectId, third));
    expect(open.filter((p) => p.status === 'SUBMITTED')).toHaveLength(1);
  });
});

describe('the object is locked while a proposal is open', () => {
  it('a direct change is 409 approval_open; pausing (a stop action) still works', async () => {
    await expect(f.agents.update(act(f.p.lead), f.maya, { description: 'direct' })).rejects.toMatchObject({ code: 'approval_open' });
    await f.agents.setStatus(act(f.p.lead), f.maya, 'PAUSED');
    const [row] = await f.t.db.select({ status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, f.maya));
    expect(row!.status).toBe('PAUSED');
  });

  it('pausing does not void the open change (status is excluded from the content hash)', async () => {
    const open = (await f.approvals.list(f.p.head2, { box: 'AWAITING_ME', limit: 50 })).rows.find((r) => r.objectId === f.maya)!;
    expect(open.warnings.map((w) => w.code)).not.toContain('content_changed');
    await expect(f.approve(f.p.head2, open.id)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('a draft agent is freely editable and never needs approval to change', async () => {
    const draft = await f.newAgent('Draft Dan');
    await expect(f.agents.update(act(f.p.lead), draft, { purpose: 'edited freely' })).resolves.toMatchObject({ purpose: 'edited freely' });
    const state = await f.approvals.objectState(f.p.lead, 'agent', draft);
    expect(state).toMatchObject({ approved: false, pending: null, updateNeedsApproval: false });
  });

  it('reports the object state: approved and the pending proposal', async () => {
    const pending = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { description: 'pending one' } });
    const state = await f.approvals.objectState(f.p.service, 'agent', f.maya);
    expect(state).toMatchObject({ approved: true, updateNeedsApproval: true, pending: { id: pending.id, checkerName: 'Anjali Rao', activating: false } });
  });

  it('another team cannot see the object (404), so cannot learn its approval state', async () => {
    await expect(f.approvals.objectState(f.p.headLoans, 'agent', f.maya)).rejects.toMatchObject({ category: 'not_found' });
  });
});
