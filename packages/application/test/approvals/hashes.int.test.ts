import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvalDecisions, modelProfiles, modelProviders, virtualAgents } from '@ocso/db';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** Content hash, dependency hash and re-validation at activation (PM/research/11b). */
let f: ApprovalFixture;
beforeAll(async () => {
  f = await createApprovalFixture();
  await f.approve(f.p.head, (await f.submit(f.p.lead, f.p.head, { action: 'ACTIVATE' })).id);
});
afterAll(async () => {
  await f?.t.drop();
});

describe('content hash: the checker approves exactly what they saw', () => {
  it('the maker edits; the old hash is 409 content_changed, the new one approves; the edit mark stays', async () => {
    const submitted = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'v1 purpose' } });
    const seen = await f.approvals.get(f.p.head, submitted.id);
    const edited = await f.approvals.edit(act(f.p.lead), submitted.id, { payload: { purpose: 'v2 purpose' } });
    expect(edited).toMatchObject({ revision: 2 });
    expect(edited.contentHash).not.toBe(seen.contentHash);
    expect(edited.warnings.map((w) => w.code)).toContain('edited_after_submission');
    await expect(f.decisions.decide(act(f.p.head), submitted.id, { decision: 'APPROVE', contentHash: seen.contentHash })).rejects.toMatchObject({ code: 'content_changed' });
    const approved = await f.decisions.decide(act(f.p.head), submitted.id, { decision: 'APPROVE', contentHash: edited.contentHash });
    expect(approved.status).toBe('APPROVED');
    const [row] = await f.t.db.select({ purpose: virtualAgents.purpose }).from(virtualAgents).where(eq(virtualAgents.id, f.maya));
    expect(row!.purpose).toBe('v2 purpose');
    const decisions = await f.t.db.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, submitted.id));
    expect(decisions.map((d) => [d.kind, d.revision])).toEqual([
      ['SUBMIT', 1],
      ['EDIT', 2],
      ['APPROVE', 2],
      ['ACTIVATE', 2],
    ]);
  });

  it('only the maker edits a proposal', async () => {
    const submitted = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'by lead' } });
    await expect(f.approvals.edit(act(f.p.head2), submitted.id, { reason: 'hijack' })).rejects.toMatchObject({ category: 'authorization' });
    await f.approvals.withdraw(act(f.p.lead), submitted.id, 'done');
  });
});

describe('dependency hash', () => {
  it('editing the referenced model profile is 409 dependency_changed against the stored hash, until the maker refreshes it', async () => {
    const submitted = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { maxToolSteps: 3 } });
    await f.t.db.update(modelProfiles).set({ temperature: 0.2, updatedAt: new Date(Date.now() + 1000) }).where(eq(modelProfiles.id, f.profile));
    await expect(f.decisions.decide(act(f.p.head), submitted.id, { decision: 'APPROVE', contentHash: submitted.contentHash })).rejects.toMatchObject({ code: 'dependency_changed' });
    const now = await f.approvals.get(f.p.head, submitted.id);
    expect(now.warnings.map((w) => w.code)).toContain('dependency_changed');
    expect(now.dependencyHash).not.toBe(submitted.dependencyHash);
    // What the checker is shown now is not enough (PM/research/11b): the stored hash is what binds.
    await expect(f.decisions.decide(act(f.p.head), submitted.id, { decision: 'APPROVE', contentHash: now.contentHash, dependencyHash: now.dependencyHash })).rejects.toMatchObject({ code: 'dependency_changed' });
    // The maker refreshes it by editing (hashes recomputed, marked edited); then it can be approved.
    const refreshed = await f.approvals.edit(act(f.p.lead), submitted.id, { reason: 'Refreshed after the profile change' });
    expect(refreshed.warnings.map((w) => w.code)).toEqual(['edited_after_submission']);
    await expect(f.approve(f.p.head, submitted.id)).resolves.toMatchObject({ status: 'APPROVED' });
  });

  it('a checker can always reject, even when the object or its dependencies drifted', async () => {
    const submitted = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { maxToolSteps: 5 } });
    await f.t.db.update(modelProfiles).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(modelProfiles.id, f.profile));
    await expect(f.decisions.decide(act(f.p.head), submitted.id, { decision: 'REJECT', reason: 'Out of date', contentHash: 'ap_stale_hash_value' })).resolves.toMatchObject({ status: 'REJECTED' });
  });
});

describe('re-validation at activation', () => {
  it('an ACTIVATE approved after its provider was disabled ends BLOCKED; the agent stays a draft', async () => {
    const agent = await f.newAgent('Blocked Bea');
    const submitted = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' });
    await f.t.db.update(modelProviders).set({ enabled: false }).where(eq(modelProviders.id, f.provider));
    const shown = await f.approvals.get(f.p.head, submitted.id);
    expect(shown.problems.map((p) => p.code)).toContain('provider_disabled');
    const decided = await f.decisions.decide(act(f.p.head), submitted.id, { decision: 'APPROVE', contentHash: shown.contentHash, dependencyHash: shown.dependencyHash });
    expect(decided).toMatchObject({ status: 'BLOCKED' });
    expect(decided.blockedReason).toContain('disabled');
    const [row] = await f.t.db.select({ status: virtualAgents.status }).from(virtualAgents).where(eq(virtualAgents.id, agent));
    expect(row!.status).toBe('DRAFT');
    const kinds = (await f.t.db.select({ kind: approvalDecisions.kind }).from(approvalDecisions).where(eq(approvalDecisions.proposalId, submitted.id))).map((d) => d.kind);
    expect(kinds).toEqual(['SUBMIT', 'BLOCK']);
    await f.t.db.update(modelProviders).set({ enabled: true }).where(eq(modelProviders.id, f.provider));
    // A blocked object is unlocked: the maker fixes it and submits again.
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' })).resolves.toMatchObject({ status: 'SUBMITTED' });
  });

  it('refuses at submit what cannot go live at all', async () => {
    const agent = (await f.agents.create(act(f.p.lead), { name: 'No Model', purpose: '', conversationType: 'SUPPORT', description: '', teamIds: [f.team.cards] })).id;
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'ACTIVATE' })).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('model profile') });
  });
});
