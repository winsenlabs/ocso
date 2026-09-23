import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { approvalDecisions, approvalProposals, modelProfiles, virtualAgents } from '@ocso/db';
import { BULK_APPROVE_MAX, BulkDecisionInput } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** Bulk approve: per-item transactions and decision rows, the warning carve-out, one batch id (PM/research/11b). */
let f: ApprovalFixture;
beforeAll(async () => {
  f = await createApprovalFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

describe('bulk approve', () => {
  it('approves the clean items, skips the ones with blocking warnings, and shares one batch id', async () => {
    const names = ['Asha', 'Bala', 'Chitra', 'Dev', 'Esha'];
    const ids = await Promise.all(names.map((n) => f.newAgent(n)));
    const proposals = [];
    for (const id of ids) proposals.push(await f.submit(f.p.lead, f.p.head, { objectId: id, action: 'ACTIVATE' }));
    // Two carry blocking warnings: one edited after submission, one whose dependency changed.
    const edited = await f.approvals.edit(act(f.p.lead), proposals[1]!.id, { reason: 'Clarified reason' });
    await f.t.db.update(modelProfiles).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(modelProfiles.id, f.profile));
    const lateAgent = await f.newAgent('Farah');
    // (profile changed after all five were submitted: every one now has dependency_changed — re-submit three cleanly.)
    for (const p of [proposals[0]!, proposals[2]!, proposals[3]!]) await f.approvals.withdraw(act(f.p.lead), p.id, 'refresh');
    const clean = [];
    for (const id of [ids[0]!, ids[2]!, ids[3]!]) clean.push(await f.submit(f.p.lead, f.p.head, { objectId: id, action: 'ACTIVATE' }));
    void lateAgent;

    const items = [...clean, edited, proposals[4]!].map((p) => ({ id: p.id, contentHash: p.contentHash }));
    const result = await f.decisions.bulkDecide(act(f.p.head), { decision: 'APPROVE', reason: 'Batch go-live', items });
    expect(result.approved.sort()).toEqual(clean.map((p) => p.id).sort());
    expect(result.skipped.map((s) => [s.id, s.code]).sort()).toEqual(
      [
        [edited.id, 'dependency_changed'],
        [proposals[4]!.id, 'dependency_changed'],
      ].sort(),
    );
    const decisions = await f.t.db.select().from(approvalDecisions).where(inArray(approvalDecisions.proposalId, result.approved));
    const approves = decisions.filter((d) => d.kind === 'APPROVE');
    expect(approves).toHaveLength(3);
    expect(new Set(approves.map((d) => d.bulkBatchId))).toEqual(new Set([result.batchId]));
    expect(approves.every((d) => d.reason === 'Batch go-live' && Array.isArray(d.diff) && d.diff.length > 0)).toBe(true);
    const live = await f.t.db.select({ id: virtualAgents.id }).from(virtualAgents).where(eq(virtualAgents.status, 'LIVE'));
    expect(live.map((r) => r.id).sort()).toEqual([ids[0]!, ids[2]!, ids[3]!].sort());
    const skippedRows = await f.t.db.select({ status: approvalProposals.status }).from(approvalProposals).where(inArray(approvalProposals.id, [edited.id, proposals[4]!.id]));
    expect(skippedRows.every((r) => r.status === 'SUBMITTED')).toBe(true);
  });

  it('skips an edited proposal and one that is not mine to check', async () => {
    const a = await f.newAgent('Gita');
    const b = await f.newAgent('Hari');
    const mine = await f.submit(f.p.lead, f.p.head, { objectId: a, action: 'ACTIVATE' });
    const edited = await f.approvals.edit(act(f.p.lead), mine.id, { reason: 'Edited once' });
    const theirs = await f.submit(f.p.lead, f.p.head2, { objectId: b, action: 'ACTIVATE' });
    const result = await f.decisions.bulkDecide(act(f.p.head), { decision: 'APPROVE', reason: 'Batch', items: [{ id: edited.id, contentHash: edited.contentHash }, { id: theirs.id, contentHash: theirs.contentHash }] });
    expect(result.approved).toEqual([]);
    expect(result.skipped.map((s) => s.code).sort()).toEqual(['edited_after_submission', 'not_checker']);
  });

  it('caps a call at 50 items and approves only (rejection needs a reason per item)', () => {
    expect(BULK_APPROVE_MAX).toBe(50);
    const item = { id: '01a0cd12-87fc-71e6-85ff-7b598bcdf97b', contentHash: 'ap_12345678' };
    expect(BulkDecisionInput.safeParse({ decision: 'APPROVE', reason: 'Batch', items: Array(51).fill(item) }).success).toBe(false);
    expect(BulkDecisionInput.safeParse({ decision: 'REJECT', reason: 'Batch', items: [item] }).success).toBe(false);
  });
});
