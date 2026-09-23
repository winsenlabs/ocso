import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { approvalProposals, userPermissionGrants, uuidv7 } from '@ocso/db';
import { RESTRICTED_TEAM, computeExceptions, recordAudit, type ExceptionReportContent } from '../../src/index.js';
import { applyAgentStatus, applyAgentUpdate } from '../../src/agents/agent-writes.js';
import { recordInstalledApproval } from '../../src/approvals/installed.js';
import { act } from '../approvals/fixture.js';
import { createExceptionFixture, type ExceptionFixture } from './fixture.js';

/**
 * What "approved" means to the exception report (ADR-033 amendments): only an
 * applied approval that puts an object live counts; configuration changed after
 * its approval without one is found in the audit trail; access increases are
 * judged by their audit rows, not a caller's opt-in marker; migration-only
 * approvals are shown; and a check survives SQL errors inside descriptor calls.
 */

let f: ExceptionFixture;
const ids: Record<string, string> = {};
let recent: ExceptionReportContent;

const compute = (dataFrom?: Partial<Record<'audit' | 'conversation' | 'operational', Date>>) => {
  const wall = Date.now();
  return computeExceptions(f.t.db, f.registry, {
    period: { start: new Date(wall - 3_600_000), end: new Date(wall + 3_600_000) },
    now: new Date(wall),
    mode: 'REPORT',
    timezone: 'UTC',
    approvalAgeWarningHours: 72,
    dataFrom,
  });
};
const items = (c: ExceptionReportContent, id: string) => c.sections.find((s) => s.id === id)!.items;

async function approvedLiveAgent(name: string): Promise<string> {
  const id = await f.newAgent(name);
  const proposal = await f.submit(f.p.lead, f.p.head, { objectId: id, action: 'ACTIVATE' });
  await f.approve(f.p.head, proposal.id);
  return id;
}

async function proposalRow(objectKind: string, objectId: string, action: 'CREATE' | 'UPDATE' | 'DELETE' | 'ACTIVATE', status: 'APPROVED' | 'REJECTED', activated: boolean): Promise<string> {
  const id = uuidv7();
  const now = new Date();
  await f.t.db.insert(approvalProposals).values({
    id,
    objectKind,
    objectId,
    action,
    payload: {},
    contentHash: 'ap_test',
    dependencyHash: 'ad_test',
    title: `${action} ${objectKind}`,
    reason: 'seeded',
    makerId: f.p.lead.userId,
    checkerId: f.p.head.userId,
  });
  // Proposals are created SUBMITTED (trigger); then decided.
  await f.t.db.update(approvalProposals).set({ status, decidedAt: now, decidedBy: f.p.head.userId }).where(eq(approvalProposals.id, id));
  if (activated) await f.t.db.update(approvalProposals).set({ activatedAt: now }).where(eq(approvalProposals.id, id));
  return id;
}

beforeAll(async () => {
  f = await createExceptionFixture(new Date());
  const { p } = f;
  // Approved and live, then paused (a stop action): nothing to report.
  ids.paused = await approvedLiveAgent('Paused properly');
  await f.agents.setStatus(act(p.head), ids.paused, 'PAUSED');
  // Approved, then changed and resumed by a path that skipped maker–checker.
  ids.bypassed = await approvedLiveAgent('Bypassed');
  await f.agents.setStatus(act(p.head), ids.bypassed, 'PAUSED');
  await f.t.db.transaction((tx) => applyAgentStatus(tx, act(p.lead), ids.bypassed!, 'LIVE'));
  await f.t.db.transaction((tx) => applyAgentUpdate(tx, act(p.lead), ids.bypassed!, { description: 'changed without a proposal' }));
  // A draft (never approved) is freely editable: not an exception.
  ids.draft = await f.newAgent('Draft only');
  await f.t.db.transaction((tx) => applyAgentUpdate(tx, act(p.lead), ids.draft!, { description: 'draft edit' }));
  // Live on an approved DELETE only, or on an approval still activating: not approved live.
  ids.deleteOnly = await f.seed.liveAgentWithoutApproval('Delete only');
  await proposalRow('agent', ids.deleteOnly, 'DELETE', 'APPROVED', true);
  ids.activating = await f.seed.liveAgentWithoutApproval('Still activating');
  await proposalRow('agent', ids.activating, 'ACTIVATE', 'APPROVED', false);
  // Installed by OCSO (a MIGRATION record): approved, but only by record.
  ids.installed = await f.seed.liveAgentWithoutApproval('Installed');
  await f.t.db.transaction((tx) => recordInstalledApproval(tx, { kind: 'agent', id: ids.installed!, title: 'Installed agent' }));
  // A grant whose proposal was rejected, and a grant with none.
  const rejected = await proposalRow('permission_change', p.service.userId, 'UPDATE', 'REJECTED', false);
  await f.t.db.insert(userPermissionGrants).values({ id: uuidv7(), userId: p.service.userId, permission: 'queues.manage', effect: 'GRANT', reason: 'rejected but applied', proposalId: rejected });
  await f.seed.grantWithoutApproval(p.head2, 'agents.delete');
  // Access raised without an approval (no skip marker), one raised through an approval, and one on a person not yet approved.
  const increase = (target: string, proposalId: string | null, status: string) =>
    f.t.db.transaction((tx) =>
      recordAudit(tx, act(p.tech), {
        action: 'user.permissions_increased',
        targetType: 'user',
        targetId: target,
        summary: `Changed access of ${target}: preset SERVICE → HEAD`,
        before: { role: 'SERVICE', status },
        after: { role: 'HEAD', status, proposalId, gained: ['agents.manage'] },
      }),
    );
  await increase(p.lead.userId, null, 'ACTIVE');
  await increase(p.headLoans.userId, uuidv7(), 'ACTIVE');
  await increase(p.head.userId, null, 'PENDING_APPROVAL');
  recent = await compute();
});

afterAll(async () => {
  await f?.t.drop();
});

describe('live without approval: only applied approvals that put an object live count', () => {
  it('an approved DELETE or an approval still activating is not an approval of the live object', () => {
    const listed = items(recent, 'live_without_approval').map((i) => i.objectId);
    expect(listed).toEqual(expect.arrayContaining([ids.deleteOnly, ids.activating]));
    expect(listed).not.toContain(ids.paused);
    expect(listed).not.toContain(ids.installed);
  });

  it('access grants are listed once, under permission_bypass, not again as a permission_change', () => {
    expect(items(recent, 'live_without_approval').some((i) => i.objectKind === 'permission_change')).toBe(false);
  });

  it('migration-only approvals are shown as information, per kind', () => {
    const installed = items(recent, 'installed_only').find((i) => i.objectKind === 'agent');
    expect(installed).toMatchObject({ count: 1, objectId: null });
    expect(installed!.title).toMatch(/1 virtual agent live on a migration record only/i);
  });
});

describe('changed outside an approval (audit trail)', () => {
  it('lists a resume and an edit of an approved agent made without a proposal, by whom', () => {
    const found = items(recent, 'changed_outside_approval').filter((i) => i.objectId === ids.bypassed);
    expect(found.map((i) => i.detail.split(' by ')[0])).toEqual(expect.arrayContaining(['agent.go_live', 'agent.update']));
    expect(found.every((i) => i.actorIds.includes(f.p.lead.userId))).toBe(true);
    expect(found.find((i) => i.detail.startsWith('agent.go_live'))!.title).toContain('taken live outside an approval');
  });

  it('is silent for the approval’s own activation, a pause (stop action) and edits of a draft', () => {
    const objects = items(recent, 'changed_outside_approval').map((i) => i.objectId);
    expect(objects).not.toContain(ids.paused);
    expect(objects).not.toContain(ids.draft);
    expect(items(recent, 'changed_outside_approval').filter((i) => i.objectId === ids.bypassed)).toHaveLength(2);
  });
});

describe('permission bypass', () => {
  it('lists a grant whose proposal is not approved, as well as one with none', () => {
    const grants = items(recent, 'permission_bypass').filter((i) => i.title.includes(' holds '));
    const rejected = grants.find((i) => i.objectId === f.p.service.userId && i.title.includes('queues.manage'))!;
    expect(rejected.detail).toContain('its proposal is rejected');
    expect(rejected).toMatchObject({ readableWith: 'users.read', subjectIds: [f.p.service.userId] });
    expect(grants.some((i) => i.objectId === f.p.head2.userId)).toBe(true);
  });

  it('lists access raised without an approval from the audit trail, without any skip marker', () => {
    const raised = items(recent, 'permission_bypass').filter((i) => i.title.startsWith('Access raised without an approval'));
    expect(raised.map((i) => i.objectId)).toEqual([f.p.lead.userId]);
    expect(raised[0]).toMatchObject({ actorIds: [f.p.tech.userId], subjectIds: [f.p.lead.userId] });
  });
});

describe('robustness and evidence limits', () => {
  it('an SQL error inside a descriptor call does not abort the check; unknown teams restrict the item to signers', async () => {
    const agent = f.registry.get('agent')!;
    const failing = (tx: { execute: (q: unknown) => Promise<unknown> }) => tx.execute(sql`SELECT * FROM no_such_table`) as never;
    const broken = { all: () => [{ ...agent, project: failing, teamIds: failing }], get: () => agent };
    const wall = Date.now();
    const out = await computeExceptions(f.t.db, broken as never, { period: { start: new Date(wall - 3_600_000), end: new Date(wall + 3_600_000) }, now: new Date(wall), mode: 'REPORT', timezone: 'UTC', approvalAgeWarningHours: 72 });
    const section = out.sections.find((s) => s.id === 'live_without_approval')!;
    expect(section.error).toBeNull();
    const item = section.items.find((i) => i.objectId === ids.deleteOnly)!;
    expect(item.teamIds).toEqual([RESTRICTED_TEAM]);
    expect(out.totals.failedChecks).toBe(0);
  });

  it('a period older than the retained history is marked incomplete (signed with the content)', async () => {
    const out = await compute({ audit: new Date(Date.now()), conversation: new Date(0) });
    expect(out.sections.find((s) => s.id === 'permission_bypass')!.coverage).toMatchObject({ complete: false });
    expect(out.sections.find((s) => s.id === 'bootstrap_approvals')!.coverage).toBeNull();
    expect(out.totals.incompleteChecks).toBeGreaterThan(0);
    expect(recent.totals.incompleteChecks).toBe(0);
  });
});
