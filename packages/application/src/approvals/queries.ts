import { and, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import { Permission, assertCan, can, type Principal } from '@ocso/auth';
import { approvalProposals, deploymentSettings, type Db } from '@ocso/db';
import type { QueueAdapter, Topic } from '@ocso/queue';
import { forbidden, notFound } from '@ocso/domain';
import { nowOf } from '../shared/context.js';
import { approvalScope, bootstrapAllowed, eligibleCheckers, mayCheck, mayReassign, type CheckerCandidate } from './access.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';
import { approvalState, assertMakeable, requiresApproval, type ApprovalState } from './guard.js';
import type { ApprovalQuery } from './inputs.js';
import type { ApprovalRegistry } from './registry.js';
import { proposalDiff } from './records.js';
import { assessProposal, type Assessment } from './warnings.js';
import { decisionsOf, namesOf, personRef, toListItem, type ProposalDetail, type ProposalListItem } from './views.js';

export interface ApprovalServiceDeps {
  now?: (() => Date) | undefined;
  /** Publishes approval.notify / approval.activate after commit; without it the leader's redispatch sweep catches up. */
  queue?: Pick<QueueAdapter, 'publish'> | undefined;
  /** Where a failed publish is reported (it is never silent; the redispatch sweeps retry it). */
  logger?: ApprovalLogger | undefined;
}

export interface ApprovalLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

export interface ApprovalKindView {
  kind: string;
  label: string;
  actions: readonly string[];
  checkPermission: Permission;
}

export interface CheckerChoice {
  checkers: CheckerCandidate[];
  /** No one else could check it and the caller holds the check permission: they may approve it themselves (BOOTSTRAP_APPROVE). */
  bootstrapAllowed: boolean;
  checkPermission: Permission;
}

export interface ObjectApprovalState extends ApprovalState {
  /** Whether an UPDATE of this object would need a proposal right now. */
  updateNeedsApproval: boolean;
  checkPermission: Permission;
}

type Page = { rows: ProposalListItem[]; next: { before: string; beforeId: string } | null };

/**
 * Read side of the approval spine: the queue, one proposal with its diff and
 * warnings, counts, checker candidates and an object's approval state. Every
 * read is scoped by approvalScope and the descriptor's own visibility (404).
 */
export class ApprovalReader {
  constructor(
    protected readonly db: Db,
    protected readonly registry: ApprovalRegistry,
    protected readonly deps: ApprovalServiceDeps = {},
  ) {}

  protected now(): Date {
    return nowOf(this.deps);
  }

  protected async publish(topic: Topic, payload: Record<string, unknown>, dedupeKey: string): Promise<void> {
    // Best effort after commit: the leader's redispatch sweeps pick up anything a crash here loses.
    await this.deps.queue?.publish(topic, payload, { dedupeKey }).catch((err: unknown) => {
      this.deps.logger?.warn({ topic, dedupeKey, err }, 'approval job publish failed; the redispatch sweep retries it');
    });
  }

  kinds(): ApprovalKindView[] {
    return this.registry.all().map((d) => ({ kind: d.kind, label: d.label, actions: d.actions, checkPermission: d.checkPermission }));
  }

  protected async ageThresholdHours(): Promise<number> {
    const [row] = await this.db.select({ hours: deploymentSettings.approvalAgeWarningHours }).from(deploymentSettings).limit(1);
    return row?.hours ?? 72;
  }

  protected async assess(d: ApprovalDescriptor | null, p: ProposalRow, viewer: Principal | null, threshold: number): Promise<Assessment | null> {
    if (!d || p.status !== 'SUBMITTED') return null;
    return assessProposal(this.db, d, p, { viewer, now: this.now(), ageThresholdHours: threshold });
  }

  async list(principal: Principal, q: ApprovalQuery): Promise<Page> {
    assertCan(principal, Permission.APPROVALS_READ);
    if (q.box === 'OPEN') assertCan(principal, Permission.APPROVALS_REASSIGN_ANY);
    const me = principal.userId;
    const where: Array<SQL | undefined> = [approvalScope(principal) ?? undefined];
    if (q.box === 'AWAITING_ME') where.push(eq(approvalProposals.checkerId, me), eq(approvalProposals.status, 'SUBMITTED'));
    if (q.box === 'SENT_BY_ME') where.push(eq(approvalProposals.makerId, me));
    if (q.box === 'OPEN') where.push(eq(approvalProposals.status, 'SUBMITTED'));
    if (q.box === 'DECIDED') where.push(ne(approvalProposals.status, 'SUBMITTED'));
    if (q.objectKind) where.push(eq(approvalProposals.objectKind, q.objectKind));
    if (q.status) where.push(eq(approvalProposals.status, q.status));
    if (q.makerId) where.push(eq(approvalProposals.makerId, q.makerId));
    if (q.checkerId) where.push(eq(approvalProposals.checkerId, q.checkerId));
    if (q.needsChecker) where.push(eq(approvalProposals.status, 'SUBMITTED'), eq(approvalProposals.checkerValid, false));
    if (q.before && q.beforeId) where.push(sql`(${approvalProposals.submittedAt}, ${approvalProposals.id}) < (${new Date(q.before)}, ${q.beforeId}::uuid)`);
    const rows = await this.db
      .select()
      .from(approvalProposals)
      .where(and(...where))
      .orderBy(desc(approvalProposals.submittedAt), desc(approvalProposals.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const threshold = await this.ageThresholdHours();
    const names = await namesOf(this.db, page.flatMap((p) => [p.makerId, p.checkerId]));
    const items: ProposalListItem[] = [];
    for (const p of page) {
      const d = this.registry.has(p.objectKind) ? this.registry.get(p.objectKind) : null;
      const a = await this.assess(d, p, principal, threshold);
      items.push(toListItem(p, { label: d?.label ?? p.objectKind, names, warnings: a?.warnings ?? (p.warnings as ProposalListItem['warnings']), dependencyHash: a?.liveDependencyHash ?? p.dependencyHash, now: this.now() }));
    }
    const last = page[page.length - 1];
    return { rows: items, next: rows.length > q.limit && last ? { before: last.submittedAt.toISOString(), beforeId: last.id } : null };
  }

  /**
   * A proposal in scope, else 404 (never 403: another team's proposal does not leak). Its maker and named
   * checker always see it (a fallback checker from another team reads the proposal, not the object). Anyone
   * else also needs the object's own visibility while the object exists — so a team that has lost ownership
   * stops reading its snapshots, open or decided; a deleted object's history stays readable in scope.
   */
  protected async load(principal: Principal, id: string): Promise<ProposalRow> {
    const scope = approvalScope(principal);
    const [row] = await this.db.select().from(approvalProposals).where(and(eq(approvalProposals.id, id), scope ?? undefined));
    if (!row) throw notFound('approval', id);
    const party = row.makerId === principal.userId || row.checkerId === principal.userId;
    if (!party && scope !== null && this.registry.has(row.objectKind)) {
      const d = this.registry.get(row.objectKind);
      if ((await d.project(this.db, row.objectId)) !== null) {
        await d.assertVisible(this.db, principal, row.objectId).catch(() => {
          throw notFound('approval', id);
        });
      }
    }
    return row;
  }

  async get(principal: Principal, id: string): Promise<ProposalDetail> {
    assertCan(principal, Permission.APPROVALS_READ);
    const p = await this.load(principal, id);
    const d = this.registry.has(p.objectKind) ? this.registry.get(p.objectKind) : null;
    const a = await this.assess(d, p, principal, await this.ageThresholdHours());
    const names = await namesOf(this.db, [p.makerId, p.checkerId, p.decidedBy]);
    const item = toListItem(p, { label: d?.label ?? p.objectKind, names, warnings: a?.warnings ?? (p.warnings as ProposalListItem['warnings']), dependencyHash: a?.liveDependencyHash ?? p.dependencyHash, now: this.now() });
    const open = p.status === 'SUBMITTED';
    const mine = p.makerId === principal.userId;
    return {
      ...item,
      diff: proposalDiff(p),
      before: p.beforeSnapshot,
      after: p.afterSnapshot,
      liveBefore: a && a.liveContentHash !== p.contentHash ? a.liveBefore : null,
      problems: [...(a?.problems ?? [])],
      decisions: await decisionsOf(this.db, p.id),
      decisionReason: p.decisionReason,
      decidedBy: personRef(names, p.decidedBy),
      blockedReason: p.blockedReason,
      activatedAt: p.activatedAt?.toISOString() ?? null,
      canDecide: d ? mayCheck(principal, d, p) : false,
      canEdit: open && mine,
      canWithdraw: open && mine,
      canReassign: open && d !== null && mayReassign(principal, d),
      canVoid: open && can(principal, Permission.APPROVALS_REASSIGN_ANY),
    };
  }

  async counts(principal: Principal): Promise<{ awaitingMe: number; sentByMe: number; open: number; needsChecker: number }> {
    assertCan(principal, Permission.APPROVALS_READ);
    const scope = approvalScope(principal) ?? undefined;
    const open = eq(approvalProposals.status, 'SUBMITTED');
    const n = async (...conds: Array<SQL | undefined>) => (await this.db.select({ n: count() }).from(approvalProposals).where(and(scope, open, ...conds)))[0]?.n ?? 0;
    const [awaitingMe, sentByMe, all, needsChecker] = await Promise.all([
      n(eq(approvalProposals.checkerId, principal.userId)),
      n(eq(approvalProposals.makerId, principal.userId)),
      n(),
      n(eq(approvalProposals.checkerValid, false)),
    ]);
    return { awaitingMe, sentByMe, open: all, needsChecker };
  }

  /** Who the caller may name as checker for a change to this object. */
  async checkerCandidates(principal: Principal, objectKind: string, objectId: string): Promise<CheckerChoice> {
    assertCan(principal, Permission.APPROVALS_READ);
    const d = this.registry.get(objectKind);
    // Only someone who could propose a change to this object learns who could check it.
    const action = d.actions.find((a) => can(principal, d.makePermission(a)));
    if (!action) throw forbidden(d.makePermission(d.actions[0]!), `${principal.displayName} cannot propose ${d.label} changes`);
    await assertMakeable(this.db, d, principal, objectId, action);
    const facts = { makerId: principal.userId, teamIds: await d.teamIds(this.db, objectId), objectKind, objectId };
    const checkers = await eligibleCheckers(this.db, d, facts, [principal.userId]);
    const bootstrap = checkers.length === 0 && (await bootstrapAllowed(this.db, d, facts, principal));
    return { checkers: checkers.map((c) => directoryView(principal, c)), bootstrapAllowed: bootstrap, checkPermission: d.checkPermission };
  }

  /** Who an open proposal could be reassigned to: eligible for it, not the maker, not the current checker. */
  async reassignCandidates(principal: Principal, id: string): Promise<CheckerCandidate[]> {
    assertCan(principal, Permission.APPROVALS_READ);
    const p = await this.load(principal, id);
    const d = this.registry.get(p.objectKind);
    this.assertMayReassign(principal, d);
    return (await eligibleCheckers(this.db, d, p, [p.makerId ?? '', p.checkerId ?? ''])).map((c) => directoryView(principal, c));
  }

  /** Approved? Pending? Would an update need approval? — for badges and the submit modal. */
  async objectState(principal: Principal, objectKind: string, objectId: string): Promise<ObjectApprovalState> {
    const d = this.registry.get(objectKind);
    await d.assertVisible(this.db, principal, objectId);
    const [state, updateNeedsApproval] = await Promise.all([approvalState(this.db, objectKind, objectId), requiresApproval(this.db, d, objectId, 'UPDATE')]);
    return { ...state, updateNeedsApproval, checkPermission: d.checkPermission };
  }

  /** Reassigning to another checker: the reassigner needs reassign_any or the kind's check permission. */
  protected assertMayReassign(principal: Principal, d: ApprovalDescriptor): void {
    if (!mayReassign(principal, d)) throw forbidden(Permission.APPROVALS_REASSIGN_ANY, `${principal.displayName} may not reassign ${d.label} approvals`);
  }
}

/** The staff directory stays behind users.read: without it a candidate is a name only. */
function directoryView(principal: Principal, c: CheckerCandidate): CheckerCandidate {
  return can(principal, Permission.USERS_READ) ? c : { id: c.id, name: c.name, email: null, role: null };
}
