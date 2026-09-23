import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { approvalDecisions, approvalProposals, auditEvents, promptVersions, virtualAgents } from '@ocso/db';
import { PromptService, isApproved } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/** The maker–checker spine end to end at the service level (PM/research/11 §4, 11b). */
let f: ApprovalFixture;
beforeAll(async () => {
  f = await createApprovalFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

const agentRow = async (id: string) => (await f.t.db.select().from(virtualAgents).where(eq(virtualAgents.id, id)))[0];
const decisionKinds = async (proposalId: string) =>
  (await f.t.db.select({ kind: approvalDecisions.kind }).from(approvalDecisions).where(eq(approvalDecisions.proposalId, proposalId)).orderBy(approvalDecisions.occurredAt)).map((r) => r.kind);

describe('taking an agent live', () => {
  it('refuses to go live directly: going live is always a proposal', async () => {
    await expect(f.agents.setStatus(act(f.p.lead), f.maya, 'LIVE')).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'agent', action: 'ACTIVATE' } });
    expect((await agentRow(f.maya))!.status).toBe('DRAFT');
  });

  it('submit → approve takes it live in one transaction with its own audit trail', async () => {
    const proposal = await f.submit(f.p.lead, f.p.head, { action: 'ACTIVATE' });
    expect(proposal).toMatchObject({ status: 'SUBMITTED', title: 'Take Maya live', objectLabel: 'Virtual agent', checker: { id: f.p.head.userId }, canEdit: true });
    expect(proposal.diff).toContainEqual({ path: 'status', before: 'DRAFT', after: 'LIVE', change: 'changed' });
    expect('payload' in proposal).toBe(false);
    expect(f.published).toContainEqual({ topic: 'approval.notify', payload: { proposalId: proposal.id, kind: 'REQUESTED' } });
    expect((await agentRow(f.maya))!.status).toBe('DRAFT');

    const decided = await f.approve(f.p.head, proposal.id);
    expect(decided).toMatchObject({ status: 'APPROVED', activating: false, decidedBy: { id: f.p.head.userId } });
    expect((await agentRow(f.maya))!.status).toBe('LIVE');
    expect(await decisionKinds(proposal.id)).toEqual(['SUBMIT', 'APPROVE', 'ACTIVATE']);
    const approveAudit = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'approval.approve'), eq(auditEvents.targetId, proposal.id)));
    const objectAudit = await f.t.db.select().from(auditEvents).where(and(eq(auditEvents.action, 'agent.go_live'), eq(auditEvents.targetId, f.maya)));
    expect(approveAudit).toHaveLength(1);
    expect(objectAudit).toHaveLength(1);
    // Same transaction: both rows share the checker's correlation id.
    expect(objectAudit[0]!.correlationId).toBe(approveAudit[0]!.correlationId);
    expect(objectAudit[0]!.actorId).toBe(f.p.head.userId);
    expect(await isApproved(f.t.db, 'agent', f.maya)).toBe(true);
    expect(f.published).toContainEqual({ topic: 'approval.notify', payload: { proposalId: proposal.id, kind: 'DECIDED' } });
  });

  it('pause is immediate and never a proposal; resuming is an ACTIVATE titled "Resume"', async () => {
    await f.agents.setStatus(act(f.p.lead), f.maya, 'PAUSED');
    expect((await agentRow(f.maya))!.status).toBe('PAUSED');
    await expect(f.agents.setStatus(act(f.p.lead), f.maya, 'LIVE')).rejects.toMatchObject({ code: 'approval_required' });
    const resume = await f.submit(f.p.lead, f.p.head2, { action: 'ACTIVATE' });
    expect(resume.title).toBe('Resume Maya');
    await f.approve(f.p.head2, resume.id);
    expect((await agentRow(f.maya))!.status).toBe('LIVE');
  });
});

describe('changing an approved agent', () => {
  it('an approved agent no longer changes directly', async () => {
    await expect(f.agents.update(act(f.p.lead), f.maya, { purpose: 'cards support' })).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'agent', action: 'UPDATE' } });
  });

  it('an UPDATE proposal carries the patch and applies it on approval', async () => {
    const proposal = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'cards support', maxToolSteps: 4 } });
    expect(proposal.title).toBe('Change Maya: max tool steps, purpose');
    expect(proposal.changedFields.sort()).toEqual(['maxToolSteps', 'purpose']);
    await f.approve(f.p.head, proposal.id);
    expect(await agentRow(f.maya)).toMatchObject({ purpose: 'cards support', maxToolSteps: 4 });
  });

  it('refuses owners and unknown fields in an UPDATE payload', async () => {
    await expect(f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { teamIds: [f.team.loans] } })).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejection leaves the agent untouched and a new proposal may follow', async () => {
    const proposal = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'something else' } });
    const shown = await f.approvals.get(f.p.head, proposal.id);
    const rejected = await f.decisions.decide(act(f.p.head), proposal.id, { decision: 'REJECT', reason: 'Wrong purpose', contentHash: shown.contentHash });
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionReason: 'Wrong purpose' });
    expect((await agentRow(f.maya))!.purpose).toBe('cards support');
    const again = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'cards and EMI support' } });
    expect(again.revision).toBe(1);
    await f.approvals.withdraw(act(f.p.lead), again.id, 'Not now');
    expect((await f.approvals.get(f.p.lead, again.id)).status).toBe('WITHDRAWN');
  });

  it('deleting needs agents.delete and a proposal; a live agent must be paused first', async () => {
    const doomed = await f.newAgent('Temp');
    await expect(f.approvals.submit(act(f.p.lead), { objectKind: 'agent', objectId: doomed, action: 'DELETE', checkerId: f.p.head.userId, reason: 'Unused' })).rejects.toMatchObject({ category: 'authorization' });
    const proposal = await f.submit(f.p.head2, f.p.head, { objectId: doomed, action: 'DELETE' });
    expect(proposal.title).toBe('Delete Temp');
    await f.approve(f.p.head, proposal.id);
    expect(await agentRow(doomed)).toBeUndefined();
    const live = await f.submit(f.p.head2, f.p.head, { objectId: f.maya, action: 'DELETE' }).catch((e: unknown) => e);
    expect(live).toMatchObject({ code: 'validation_failed' });
  });
});

describe('prompt versions', () => {
  it('a draft agent activates prompts directly; once approved, activation is a prompt_version proposal', async () => {
    const prompts = new PromptService(f.t.db);
    const draft = await f.newAgent('Sana');
    const edit = async (agentId: string, identity: string) => prompts.saveDraft(act(f.p.lead), agentId, { ...(await prompts.draft(f.p.lead, agentId)).components, identity } as never);
    await edit(draft, 'Sana helps with cards');
    const v2 = await prompts.createVersionFromDraft(act(f.p.lead), draft, { reason: 'Clearer identity' });
    await prompts.activate(act(f.p.lead), draft, v2.id);

    await edit(f.maya, 'Maya, v2');
    const next = await prompts.createVersionFromDraft(act(f.p.lead), f.maya, { reason: 'Tighter identity' });
    await expect(prompts.activate(act(f.p.lead), f.maya, next.id)).rejects.toMatchObject({ code: 'approval_required', details: { objectKind: 'prompt_version' } });
    const proposal = await f.submit(f.p.lead, f.p.head, { objectKind: 'prompt_version', objectId: next.id, action: 'ACTIVATE' });
    expect(proposal.title).toBe('Activate prompt v2 for Maya');
    expect(proposal.changedFields).toContain('components.identity');
    await f.approve(f.p.head, proposal.id);
    const [agent] = await f.t.db.select({ active: virtualAgents.activePromptVersionId }).from(virtualAgents).where(eq(virtualAgents.id, f.maya));
    expect(agent!.active).toBe(next.id);
    const [stamped] = await f.t.db.select().from(promptVersions).where(eq(promptVersions.id, next.id));
    expect(stamped!.firstActivatedAt).not.toBeNull();
  });
});

describe('counts and lists', () => {
  it('counts what awaits the checker and what the maker sent', async () => {
    const open = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { description: 'Handles cards' } });
    expect(await f.approvals.counts(f.p.head)).toMatchObject({ awaitingMe: 1 });
    expect(await f.approvals.counts(f.p.lead)).toMatchObject({ sentByMe: 1 });
    const awaiting = await f.approvals.list(f.p.head, { box: 'AWAITING_ME', limit: 50 });
    expect(awaiting.rows.map((r) => r.id)).toEqual([open.id]);
    const decided = await f.approvals.list(f.p.lead, { box: 'DECIDED', limit: 2 });
    expect(decided.rows).toHaveLength(2);
    expect(decided.next).not.toBeNull();
    const older = await f.approvals.list(f.p.lead, { box: 'DECIDED', limit: 50, before: decided.next!.before, beforeId: decided.next!.beforeId });
    expect(older.rows.map((r) => r.id)).not.toContain(decided.rows[0]!.id);
    await f.approvals.withdraw(act(f.p.lead), open.id, 'Later');
    const { rows } = await f.t.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${approvalProposals} WHERE status = 'SUBMITTED'`);
    expect(rows[0]!.n).toBe(0);
  });
});
