'use server';

import { refresh } from 'next/cache';
import { APPROVAL_CHECK_PERMISSIONS, Permission } from '@ocso/auth';
import { z } from 'zod';
import type { CheckerChoice } from '@/components/approvals/lib/schemas';
import { bulkApprove, checkerChoice, decideApproval, editApproval, reassignApproval, voidApproval, withdrawApproval } from '../api/approvals';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Approval queue actions (PM/research/11 §4). Inputs are validated here and
 * again by the API, which is the enforcement point: it checks that the
 * decider is the named checker, never the maker, and that the content hash
 * is still what they were shown.
 */
export type ApprovalActionResult<T = null> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined };

const Id = z.uuid();
const Reason = z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500);
const Hash = z.string().min(8).max(64);

async function run<I, T>(schema: z.ZodType<I>, raw: unknown, call: (input: I) => Promise<T>, permissions?: readonly Permission[], reload = true): Promise<ApprovalActionResult<T>> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') };
  const session = await getSession();
  if (!session) return { ok: false, message: 'Your session has ended. Sign in again.' };
  if (permissions && !permissions.some((p) => session.permissions.has(p))) return { ok: false, message: 'Your role cannot do this.' };
  try {
    const data = await call(parsed.data);
    if (reload) refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

const Decision = z.object({
  id: Id,
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(500),
  contentHash: Hash,
  dependencyHash: Hash.optional(),
});

export async function decideApprovalAction(input: z.input<typeof Decision>): Promise<ApprovalActionResult<{ status: string }>> {
  return run(
    Decision.refine((v) => v.decision === 'APPROVE' || v.reason.length >= 3, { message: 'Give a reason of at least 3 characters to reject' }),
    input,
    async (i) => {
      const detail = await decideApproval(i.id, { decision: i.decision, reason: i.reason || undefined, contentHash: i.contentHash, dependencyHash: i.dependencyHash });
      return { status: detail.status };
    },
    APPROVAL_CHECK_PERMISSIONS,
  );
}

const Bulk = z.object({ reason: Reason, items: z.array(z.object({ id: Id, contentHash: Hash })).min(1).max(50) });

export async function bulkApproveAction(input: z.input<typeof Bulk>): Promise<ApprovalActionResult<{ approved: number; skipped: Array<{ id: string; message: string }> }>> {
  return run(
    Bulk,
    input,
    async (i) => {
      const result = await bulkApprove(i);
      return { approved: result.approved.length, skipped: result.skipped.map((s) => ({ id: s.id, message: s.message })) };
    },
    APPROVAL_CHECK_PERMISSIONS,
  );
}

export async function reassignApprovalAction(id: string, checkerId: string, reason: string): Promise<ApprovalActionResult> {
  return run(
    z.object({ id: Id, checkerId: Id, reason: Reason }),
    { id, checkerId, reason },
    async (i) => {
      await reassignApproval(i.id, { checkerId: i.checkerId, reason: i.reason });
      return null;
    },
    [Permission.APPROVALS_REASSIGN_ANY, ...APPROVAL_CHECK_PERMISSIONS],
  );
}

export async function withdrawApprovalAction(id: string, reason: string): Promise<ApprovalActionResult> {
  return run(z.object({ id: Id, reason: Reason }), { id, reason }, async (i) => {
    await withdrawApproval(i.id, i.reason);
    return null;
  });
}

/** Void an open proposal nobody can decide any more (approvals.reassign_any; audited). */
export async function voidApprovalAction(id: string, reason: string): Promise<ApprovalActionResult> {
  return run(
    z.object({ id: Id, reason: Reason }),
    { id, reason },
    async (i) => {
      await voidApproval(i.id, i.reason);
      return null;
    },
    [Permission.APPROVALS_REASSIGN_ANY],
  );
}

export async function editApprovalAction(id: string, patch: { checkerId?: string; reason?: string }): Promise<ApprovalActionResult> {
  return run(z.object({ id: Id, checkerId: Id.optional(), reason: Reason.optional() }), { id, ...patch }, async ({ id: pid, ...rest }) => {
    await editApproval(pid, rest);
    return null;
  });
}

/** Who may be named as checker for a change to this object (the submit modal loads it on open). */
export async function checkerChoiceAction(objectKind: string, objectId: string): Promise<ApprovalActionResult<CheckerChoice>> {
  return run(z.object({ objectKind: z.string().min(1).max(60), objectId: Id }), { objectKind, objectId }, (i) => checkerChoice(i.objectKind, i.objectId), [Permission.APPROVALS_READ], false);
}
