import { asc, eq, inArray } from 'drizzle-orm';
import { approvalDecisions, users, type DbOrTx } from '@ocso/db';
import type { ApprovalAction, ApprovalDecisionKind, ApprovalStatus, ApprovalWarning, DiffField } from '@ocso/domain';
import type { ApprovalProblem, ProposalRow } from './contract.js';
import { proposalDiff } from './records.js';

/** What the API returns about proposals. `payload` is never included (it may be replayed, so it is never redacted). */
export interface ApprovalPersonRef {
  id: string;
  name: string;
}

export interface ProposalListItem {
  id: string;
  objectKind: string;
  objectLabel: string;
  objectId: string;
  action: ApprovalAction;
  status: ApprovalStatus;
  origin: 'USER' | 'MIGRATION';
  /** Approved, not yet activated (deferred path). */
  activating: boolean;
  bootstrap: boolean;
  title: string;
  reason: string;
  revision: number;
  maker: ApprovalPersonRef | null;
  checker: ApprovalPersonRef | null;
  checkerValid: boolean;
  submittedAt: string;
  decidedAt: string | null;
  ageSeconds: number;
  warnings: ApprovalWarning[];
  contentHash: string;
  /** The dependency hash as of now (send it back with a decision to approve knowingly after a dependency changed). */
  dependencyHash: string;
  changedFields: string[];
}

export interface DecisionView {
  id: string;
  kind: ApprovalDecisionKind;
  revision: number;
  actor: ApprovalPersonRef | null;
  actorName: string;
  reason: string | null;
  contentHash: string;
  bulkBatchId: string | null;
  /** INTERNAL_AGENT: made through Ask OCSO for the actor ("submitted via Ask OCSO"); null otherwise. */
  via: 'INTERNAL_AGENT' | null;
  occurredAt: string;
}

export interface ProposalDetail extends ProposalListItem {
  diff: DiffField[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  /** The object as it is now, when it differs from `before` (content_changed). */
  liveBefore: Record<string, unknown> | null;
  problems: ApprovalProblem[];
  decisions: DecisionView[];
  decisionReason: string | null;
  decidedBy: ApprovalPersonRef | null;
  blockedReason: string | null;
  activatedAt: string | null;
  canDecide: boolean;
  canEdit: boolean;
  canWithdraw: boolean;
  canReassign: boolean;
  /** Open, and the viewer holds approvals.reassign_any: may void it with a reason. */
  canVoid: boolean;
}

export async function namesOf(tx: DbOrTx, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!unique.length) return new Map();
  const rows = await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

const ref = (names: Map<string, string>, id: string | null): ApprovalPersonRef | null => (id ? { id, name: names.get(id) ?? 'Unknown user' } : null);

export function toListItem(
  p: ProposalRow,
  ctx: { label: string; names: Map<string, string>; warnings: ApprovalWarning[]; dependencyHash: string; now: Date },
): ProposalListItem {
  return {
    id: p.id,
    objectKind: p.objectKind,
    objectLabel: ctx.label,
    objectId: p.objectId,
    action: p.action,
    status: p.status,
    origin: p.origin,
    activating: p.status === 'APPROVED' && p.activatedAt === null,
    bootstrap: p.bootstrap,
    title: p.title,
    reason: p.reason,
    revision: p.revision,
    maker: ref(ctx.names, p.makerId),
    checker: ref(ctx.names, p.checkerId),
    checkerValid: p.checkerValid,
    submittedAt: p.submittedAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    ageSeconds: Math.max(0, Math.round(((p.decidedAt ?? ctx.now).getTime() - p.submittedAt.getTime()) / 1000)),
    warnings: ctx.warnings,
    contentHash: p.contentHash,
    dependencyHash: ctx.dependencyHash,
    changedFields: [...new Set(proposalDiff(p).map((f) => f.path))],
  };
}

export async function decisionsOf(tx: DbOrTx, proposalId: string): Promise<DecisionView[]> {
  const rows = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.proposalId, proposalId)).orderBy(asc(approvalDecisions.occurredAt), asc(approvalDecisions.id));
  const names = await namesOf(tx, rows.map((r) => r.actorId));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    revision: r.revision,
    actor: ref(names, r.actorId),
    actorName: r.actorName,
    reason: r.reason,
    contentHash: r.contentHash,
    bulkBatchId: r.bulkBatchId,
    via: r.via ?? null,
    occurredAt: r.occurredAt.toISOString(),
  }));
}

export { ref as personRef };
