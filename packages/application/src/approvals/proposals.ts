import { eq } from 'drizzle-orm';
import type { Principal } from '@ocso/auth';
import { approvalProposals, uuidv7, type DbOrTx } from '@ocso/db';
import { DomainError, ErrorCategory, approvalTransition, conflict, diffFields, forbidden, notFound, validation, type ApprovalAction } from '@ocso/domain';
import { TOPICS } from '@ocso/queue';
import { z } from 'zod';
import type { ActorContext } from '../shared/context.js';
import { assertCanMake, bootstrapAllowed, isEligibleChecker, loadPerson } from './access.js';
import { applyDecision } from './activation.js';
import type { ApprovalDescriptor, ProposalRow } from './contract.js';
import { approvalOpenError, assertMakeable, lockFor, lockingProposal, requiresApproval } from './guard.js';
import { contentBasisOf, dependencyHashOf, dependencyKeysOf, proposalContentHash, snapshotOf, type Snapshot } from './hashing.js';
import type { ApprovalEditInput, ApprovalRequest } from './inputs.js';
import { ApprovalReader } from './queries.js';
import { emitDecided, emitRequested, proposalDiff, recordDecision } from './records.js';
import type { ProposalDetail } from './views.js';

export interface SubmitCommand {
  objectKind: string;
  objectId: string;
  action: ApprovalAction;
  checkerId?: string | undefined;
  bootstrap?: true | undefined;
  reason: string;
  payload?: Record<string, unknown> | undefined;
}

const BOOTSTRAP_REASON = 'No other eligible checker exists';

/**
 * Maker side of the approval spine (PM/research/11 §4, 11b "Submit"): submit,
 * edit, withdraw. One open proposal per object (advisory lock + partial unique
 * index); the named checker must be eligible; a bootstrap approval is allowed
 * only when nobody else could check it and the maker holds the check permission.
 */
export class ApprovalService extends ApprovalReader {
  /** Whether a write must be a proposal, and the open proposal that locks the object (for requestApproval). */
  async gate(principal: Principal, kind: string, objectId: string, action: ApprovalAction): Promise<{ needed: boolean; openId: string | null }> {
    const d = this.registry.get(kind);
    await assertMakeable(this.db, d, principal, objectId, action);
    const open = await lockingProposal(this.db, d, objectId);
    return { needed: await requiresApproval(this.db, d, objectId, action), openId: open?.id ?? null };
  }

  /** The command an approvable write endpoint builds from `approval` in its body. */
  static commandFor(target: Omit<SubmitCommand, 'checkerId' | 'bootstrap' | 'reason'>, approval: ApprovalRequest): SubmitCommand {
    return 'bootstrap' in approval
      ? { ...target, bootstrap: true, reason: approval.reason ?? BOOTSTRAP_REASON }
      : { ...target, checkerId: approval.checkerId, reason: approval.reason };
  }

  async submit(actor: ActorContext, input: SubmitCommand): Promise<ProposalDetail> {
    const principal = actor.principal!;
    const d = this.registry.get(input.objectKind);
    if (!d.actions.includes(input.action)) throw validation('action_not_approvable', `${d.label}: ${input.action.toLowerCase()} is not an approvable action`);
    assertCanMake(principal, d, input.action);
    await assertMakeable(this.db, d, principal, input.objectId, input.action);
    const payload = this.parsePayload(d, input.action, input.payload ?? {});
    const now = this.now();
    const result = await this.db.transaction(async (tx) => {
      // The object's lock first (the same one decisions and direct writes take), then everything is read under it.
      await lockFor(tx, d, input.objectId);
      const open = await lockingProposal(tx, d, input.objectId);
      if (open) throw approvalOpenError(open.kind, open.objectId, open.id);
      const before = snapshotOf(await d.project(tx, input.objectId));
      if (!before) throw notFound(d.kind, input.objectId);
      const teamIds = await d.teamIds(tx, input.objectId, payload);
      const checkerId = input.bootstrap ? principal.userId : input.checkerId!;
      const basis = await contentBasisOf(tx, d, input.objectId, before);
      const row = draftRow({ id: uuidv7(), d, input, payload, before, basis, teamIds, makerId: principal.userId, checkerId, bootstrap: input.bootstrap === true, now });
      if (input.bootstrap) {
        if (!(await bootstrapAllowed(tx, d, row, principal))) throw validation('bootstrap_not_allowed', 'Bootstrap approval is only allowed when no other eligible checker exists and you hold the check permission');
      } else if (!(await isEligibleChecker(tx, d, row, await loadPerson(tx, checkerId)))) {
        throw validation('checker_not_eligible', 'The named checker cannot approve this change: they must be active, hold the approval permission for it, share a team with it, and not be you');
      }
      row.afterSnapshot = snapshotOf(await d.projectAfter(tx, row));
      assertChanges(row);
      const dependencies = await d.dependencies(tx, row);
      row.dependencyKeys = dependencyKeysOf(dependencies);
      row.dependencyHash = dependencyHashOf(dependencies);
      const problems = await d.validate(tx, row);
      const hard = problems.filter((p) => !p.soft);
      if (hard.length) throw validation('validation_failed', hard.map((p) => p.message).join(' '), { problems: hard });
      row.title = d.title(row, before);
      const [inserted] = await tx.insert(approvalProposals).values(row).returning();
      await recordDecision(tx, actor, inserted!, 'SUBMIT', { reason: row.reason, diff: proposalDiff(inserted!) });
      if (!input.bootstrap) {
        await emitRequested(tx, actor, inserted!);
        return { id: inserted!.id, deferred: false, notify: true };
      }
      const decided = await applyDecision(tx, d, actor, inserted!, 'BOOTSTRAP_APPROVE', { reason: row.reason, now, warnings: [], dependencyHash: row.dependencyHash });
      if (decided.outcome !== 'APPROVED') throw validation('validation_failed', 'The change no longer passes validation');
      return { id: inserted!.id, deferred: decided.deferred, notify: false };
    });
    if (result.notify) await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: result.id, kind: 'REQUESTED' }, `approval-notify:${result.id}:requested:1`);
    if (result.deferred) await this.publish(TOPICS.APPROVAL_ACTIVATE, { proposalId: result.id }, `approval-activate:${result.id}`);
    return this.get(principal, result.id);
  }

  /** The maker changes the proposal (never the locked object): revision+1, hashes recomputed, marked edited. */
  async edit(actor: ActorContext, id: string, input: ApprovalEditInput): Promise<ProposalDetail> {
    const principal = actor.principal!;
    const now = this.now();
    const notify = await this.db.transaction(async (tx) => {
      const p = await this.lockOwn(tx, principal, id);
      const d = this.registry.get(p.objectKind);
      assertCanMake(principal, d, p.action);
      await assertMakeable(tx, d, principal, p.objectId, p.action);
      approvalTransition(p.status, 'EDIT');
      await lockFor(tx, d, p.objectId);
      const payload = input.payload !== undefined ? this.parsePayload(d, p.action, input.payload) : p.payload;
      const checkerId = input.checkerId ?? p.checkerId!;
      const before = snapshotOf(await d.project(tx, p.objectId));
      if (!before) throw notFound(d.kind, p.objectId);
      const next: ProposalRow = { ...p, payload, checkerId, reason: input.reason ?? p.reason, revision: p.revision + 1, beforeSnapshot: before, editedAfterSubmission: true, updatedAt: now };
      // An edited payload may move the object to another owner (a rule retargeted): its teams, and the checker, follow.
      next.teamIds = await d.teamIds(tx, p.objectId, payload);
      if (checkerId !== p.checkerId || !p.checkerValid || next.teamIds.join() !== p.teamIds.join()) {
        if (!(await isEligibleChecker(tx, d, next, await loadPerson(tx, checkerId)))) throw validation('checker_not_eligible', 'The named checker cannot approve this change');
        next.checkerValid = true;
        next.notifiedAt = null;
      }
      next.afterSnapshot = snapshotOf(await d.projectAfter(tx, next));
      assertChanges(next);
      const dependencies = await d.dependencies(tx, next);
      next.dependencyKeys = dependencyKeysOf(dependencies);
      next.dependencyHash = dependencyHashOf(dependencies);
      const hard = (await d.validate(tx, next)).filter((x) => !x.soft);
      if (hard.length) throw validation('validation_failed', hard.map((x) => x.message).join(' '), { problems: hard });
      next.contentHash = proposalContentHash({ ...next, beforeSnapshot: await contentBasisOf(tx, d, p.objectId, before) }, d.hashExclude);
      next.title = d.title(next, before);
      const { id: _id, createdAt: _c, ...changes } = next;
      const [row] = await tx.update(approvalProposals).set(changes).where(eq(approvalProposals.id, id)).returning();
      await recordDecision(tx, actor, row!, 'EDIT', { reason: row!.reason, diff: proposalDiff(row!) });
      if (checkerId !== p.checkerId) await emitRequested(tx, actor, row!);
      return checkerId !== p.checkerId ? row!.revision : null;
    });
    if (notify !== null) await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: id, kind: 'REQUESTED' }, `approval-notify:${id}:requested:${notify}`);
    return this.get(principal, id);
  }

  async withdraw(actor: ActorContext, id: string, reason: string): Promise<void> {
    const principal = actor.principal!;
    const now = this.now();
    await this.db.transaction(async (tx) => {
      const p = await this.lockOwn(tx, principal, id);
      approvalTransition(p.status, 'WITHDRAW');
      const [row] = await tx
        .update(approvalProposals)
        .set({ status: 'WITHDRAWN', decidedAt: now, decidedBy: principal.userId, decisionReason: reason, updatedAt: now })
        .where(eq(approvalProposals.id, id))
        .returning();
      await recordDecision(tx, actor, row!, 'WITHDRAW', { reason });
      await emitDecided(tx, actor, row!, 'WITHDRAWN');
    });
    // The checker who was asked is told it was withdrawn (email; the in-app notice is the event above).
    await this.publish(TOPICS.APPROVAL_NOTIFY, { proposalId: id, kind: 'DECIDED' }, `approval-notify:${id}:decided:WITHDRAWN`);
  }

  /** Lock one of my own open proposals (only the maker edits or withdraws). */
  private async lockOwn(tx: DbOrTx, principal: Principal, id: string): Promise<ProposalRow> {
    await this.load(principal, id);
    const [p] = await tx.select().from(approvalProposals).where(eq(approvalProposals.id, id)).for('update');
    if (!p) throw notFound('approval', id);
    if (p.makerId !== principal.userId) throw forbidden('approval.edit', 'only the maker can change or withdraw a proposal');
    if (p.status !== 'SUBMITTED') throw conflict('not_open', 'This proposal has already been decided');
    return p;
  }

  private parsePayload(d: ApprovalDescriptor, action: ApprovalAction, raw: Record<string, unknown>): Record<string, unknown> {
    if ((action !== 'CREATE' && action !== 'UPDATE') || !d.payload) return {};
    const parsed = d.payload.safeParse(raw);
    if (!parsed.success) throw new DomainError(ErrorCategory.VALIDATION, 'invalid_payload', z.prettifyError(parsed.error));
    return parsed.data as Record<string, unknown>;
  }
}

/** An UPDATE that changes nothing the checker can see is refused: it would approve a change nobody reviewed. */
function assertChanges(row: ProposalRow): void {
  if (row.action === 'UPDATE' && diffFields(row.beforeSnapshot, row.afterSnapshot).length === 0) {
    throw validation('no_changes', 'This change does not alter anything: there is nothing to approve.');
  }
}

function draftRow(a: {
  id: string;
  d: ApprovalDescriptor;
  input: SubmitCommand;
  payload: Record<string, unknown>;
  before: Record<string, unknown>;
  basis: Snapshot;
  teamIds: string[];
  makerId: string;
  checkerId: string;
  bootstrap: boolean;
  now: Date;
}): ProposalRow {
  const base = { objectKind: a.d.kind, objectId: a.input.objectId, action: a.input.action, revision: 1, payload: a.payload, beforeSnapshot: a.before };
  return {
    id: a.id,
    ...base,
    status: 'SUBMITTED',
    origin: 'USER',
    afterSnapshot: null,
    contentHash: proposalContentHash({ ...base, beforeSnapshot: a.basis }, a.d.hashExclude),
    dependencyKeys: [],
    dependencyHash: dependencyHashOf([]),
    teamIds: a.teamIds,
    title: a.d.label,
    reason: a.input.reason,
    makerId: a.makerId,
    checkerId: a.checkerId,
    checkerValid: true,
    editedAfterSubmission: false,
    bootstrap: a.bootstrap,
    warnings: [],
    submittedAt: a.now,
    notifiedAt: null,
    decidedAt: null,
    decidedBy: null,
    decisionReason: null,
    activatedAt: null,
    activationAttempts: 0,
    blockedReason: null,
    createdAt: a.now,
    updatedAt: a.now,
  };
}

