import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { Permission, ROLE_PERMISSIONS, type Principal } from '@ocso/auth';
import { channels, teamMembers, users, uuidv7, virtualAgents } from '@ocso/db';
import { systemActor, voidOrphanProposals } from '../../src/index.js';
import { act, createApprovalFixture, type ApprovalFixture } from './fixture.js';

/**
 * Findings of the ADR-030 review: write-scoped proposing, visible slug
 * changes, empty diffs, deleting a legacy channel default, re-checked
 * eligibility at decision, void (admin and sweep), withdraw notices and the
 * staff directory behind users.read.
 */
let f: ApprovalFixture;
beforeAll(async () => {
  f = await createApprovalFixture();
});
afterAll(async () => {
  await f?.t.drop();
});

describe('proposing is scoped like writing', () => {
  it('agents.read_all plus manage rights (per-user grants) cannot propose for another team’s agent', async () => {
    const reader: Principal = {
      userId: f.p.headLoans.userId,
      role: 'HEAD',
      displayName: 'Rohan Kapoor',
      teamIds: [f.team.loans],
      via: 'UI',
      permissions: new Set([...ROLE_PERMISSIONS.HEAD, Permission.AGENTS_READ_ALL]),
    };
    await expect(f.approvals.submit(act(reader), { objectKind: 'agent', objectId: f.maya, action: 'UPDATE', checkerId: f.p.head.userId, reason: 'Foreign', payload: { purpose: 'x' } })).rejects.toMatchObject({
      category: 'not_found',
    });
    await expect(f.approvals.gate(reader, 'agent', f.maya, 'UPDATE')).rejects.toMatchObject({ category: 'not_found' });
    await expect(f.approvals.checkerCandidates(reader, 'agent', f.maya)).rejects.toMatchObject({ category: 'not_found' });
  });

  it('only someone who could propose learns the candidates; without users.read they are names only', async () => {
    await expect(f.approvals.checkerCandidates(f.p.service, 'agent', f.maya)).rejects.toMatchObject({ category: 'authorization' });
    const withoutDirectory: Principal = { ...f.p.lead, permissions: new Set([...ROLE_PERMISSIONS.LEAD].filter((p) => p !== Permission.USERS_READ)) };
    const choice = await f.approvals.checkerCandidates(withoutDirectory, 'agent', f.maya);
    expect(choice.checkers.map((c) => [c.email, c.role])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect((await f.approvals.checkerCandidates(f.p.lead, 'agent', f.maya)).checkers[0]!.email).toContain('@bank.test');
  });
});

describe('the checker sees every change', () => {
  it('a slug change is in the diff and title; a clash is refused at submit; a no-op is refused', async () => {
    const agent = await f.newAgent('Sluggy');
    const p = await f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { slug: 'sluggy-renamed' } });
    expect(p.changedFields).toEqual(['slug']);
    expect(p.title).toContain('slug');
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
    const [maya] = await f.t.db.select({ slug: virtualAgents.slug }).from(virtualAgents).where(eq(virtualAgents.id, f.maya));
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { slug: maya!.slug } })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { purpose: 'support' } })).rejects.toMatchObject({ code: 'no_changes' });
    await expect(f.submit(f.p.lead, f.p.head, { objectId: agent, action: 'UPDATE', payload: { channelIds: [uuidv7()], purpose: 'y' } })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});

describe('deleting', () => {
  it('an agent that is still a legacy channel default is deleted (the deprecated pointer is cleared)', async () => {
    const agent = await f.newAgent('Legacy Lou');
    const channel = uuidv7();
    await f.t.db.insert(channels).values({ id: channel, kind: 'WEBCHAT', name: 'Legacy web', status: 'ACTIVE', publicKey: `pk-${channel}`, defaultAgentId: agent });
    const p = await f.approvals.submit(act(f.p.head), { objectKind: 'agent', objectId: agent, action: 'DELETE', checkerId: f.p.head2.userId, reason: 'Retire' });
    await expect(f.approve(f.p.head2, p.id)).resolves.toMatchObject({ status: 'APPROVED' });
    const [row] = await f.t.db.select({ d: channels.defaultAgentId }).from(channels).where(eq(channels.id, channel));
    expect(row!.d).toBeNull();
  });

  it('prompt versions cannot be deleted by naming the agent in a session setting any more', async () => {
    await expect(
      f.t.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('ocso.approved_agent_delete', ${f.maya}, true)`);
        await tx.execute(sql`DELETE FROM prompt_versions WHERE agent_id = ${f.maya}`);
      }),
    ).rejects.toMatchObject({ cause: { message: 'prompt_versions are immutable' } });
  });
});

describe('deciding re-checks the checker', () => {
  it('a checker moved out of the owning team cannot decide, before any sweep has run', async () => {
    const p = await f.submit(f.p.lead, f.p.head2, { action: 'UPDATE', payload: { purpose: 'moved checker' } });
    await f.t.db.delete(teamMembers).where(eq(teamMembers.userId, f.p.head2.userId));
    const moved: Principal = { ...f.p.head2, teamIds: [] };
    await expect(f.decisions.decide(act(moved), p.id, { decision: 'APPROVE', contentHash: p.contentHash })).rejects.toMatchObject({ code: 'checker_invalid' });
    await f.t.db.insert(teamMembers).values({ teamId: f.team.cards, userId: f.p.head2.userId });
    await f.approvals.withdraw(act(f.p.lead), p.id, 'done');
  });

  it('withdrawing tells the checker (approval.notify DECIDED)', async () => {
    const p = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'to withdraw' } });
    f.published.length = 0;
    await f.approvals.withdraw(act(f.p.lead), p.id, 'Changed my mind');
    expect(f.published).toContainEqual({ topic: 'approval.notify', payload: { proposalId: p.id, kind: 'DECIDED' } });
  });
});

describe('void', () => {
  it('approvals.reassign_any voids a stuck proposal with a reason; nobody else can', async () => {
    const p = await f.submit(f.p.lead, f.p.head, { action: 'UPDATE', payload: { purpose: 'stuck' } });
    await expect(f.decisions.voidProposal(act(f.p.head), p.id, 'Not mine to void')).rejects.toMatchObject({ category: 'authorization' });
    const detail = await f.approvals.get(f.p.tech, p.id);
    expect(detail.canVoid).toBe(true);
    const voided = await f.decisions.voidProposal(act(f.p.tech), p.id, 'Maker on leave; object drifted');
    expect(voided).toMatchObject({ status: 'VOID', decisionReason: 'Maker on leave; object drifted', decidedBy: { id: f.p.tech.userId } });
    expect(voided.decisions.map((d) => d.kind)).toEqual(['SUBMIT', 'VOID']);
  });

  it('the sweep voids proposals whose maker is no longer active', async () => {
    const lead2 = uuidv7();
    await f.t.db.insert(users).values({ id: lead2, email: 'leo@bank.test', name: 'Leo Lead', role: 'LEAD' });
    await f.t.db.insert(teamMembers).values({ teamId: f.team.cards, userId: lead2 });
    const leo: Principal = { userId: lead2, role: 'LEAD', displayName: 'Leo Lead', teamIds: [f.team.cards], via: 'UI' };
    const p = await f.submit(leo, f.p.head, { action: 'UPDATE', payload: { purpose: 'left behind' } });
    await f.t.db.update(users).set({ status: 'DISABLED' }).where(eq(users.id, lead2));
    expect(await voidOrphanProposals(f.t.db, f.registry, systemActor('sweep', 'maker-gone'))).toBe(1);
    expect(await f.approvals.get(f.p.tech, p.id)).toMatchObject({ status: 'VOID', decisionReason: "The maker's account is no longer active" });
  });
});
