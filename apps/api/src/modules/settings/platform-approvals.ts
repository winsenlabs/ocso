import type { Principal } from '@ocso/auth';
import { ApprovalService, WithApproval, requestApproval, type ActorContext, type ApprovalRequest } from '@ocso/application';
import { isDomainError, validation } from '@ocso/domain';
import type { Response } from 'express';
import type { z } from 'zod';
import { approvalResponse } from '../approvals/approval-response.js';

/**
 * Controller helpers for the platform objects under maker–checker (PM/research/11 §4, wave 2
 * COVERAGE-PLATFORM): channels, model providers/profiles/pricing, MCP connections, notification
 * destinations, webhooks, SSO providers and the deployment settings.
 */

/** `{ approval? }` for writes whose body may be empty (DELETE, activate): parsed from an absent body too. */
export const OptionalApproval = WithApproval.optional();
export type ApprovalBody = z.infer<typeof OptionalApproval>;

/** Each object with its maker–checker state (the pending badge and whether an edit needs a checker). */
export async function withApprovalState<T extends { id: string }>(approvals: ApprovalService, principal: Principal, kind: string, rows: readonly T[]): Promise<Array<T & { approval: Awaited<ReturnType<ApprovalService['objectState']>> }>> {
  return Promise.all(rows.map(async (row) => ({ ...row, approval: await approvals.objectState(principal, kind, row.id) })));
}

/**
 * Create-and-activate: the object is created as a draft (201); when the body asked for it live (`live`), the
 * ACTIVATE proposal is submitted with `approval` in the same call and the answer is 202 `{ …object, proposal }`.
 * Asking for it live without `approval` is refused before anything is created (nothing to name a checker on yet).
 * When that submit is refused (checker not eligible, bootstrap not allowed, validation) the draft still exists:
 * the answer is 201 with the draft and `activationError`, so the client retries the activation on that id
 * instead of creating a duplicate.
 */
export async function createDraft<T extends { id: string }>(
  res: Response,
  o: { approvals: ApprovalService; actor: ActorContext; kind: string; live: boolean; approval: ApprovalRequest | undefined; create: () => Promise<T> },
): Promise<T | (T & { proposal: unknown }) | (T & { activationError: unknown })> {
  if (o.live && !o.approval) {
    throw validation('activation_needs_approval', 'A new object starts as a draft: create it, then activate it with a named checker (or send `approval` with this request).');
  }
  const created = await o.create();
  if (!o.live) return created;
  try {
    const outcome = await approvalResponse(res, requestApproval(o.approvals, o.actor, { objectKind: o.kind, objectId: created.id, action: 'ACTIVATE' }, o.approval, null));
    return { ...created, ...(outcome as { proposal: unknown }) };
  } catch (err) {
    if (!isDomainError(err)) throw err;
    res.status(201);
    return { ...created, activationError: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } };
  }
}

/** An always-proposal write (ACTIVATE, DELETE): 202 `{ proposal }` with `approval`, else 409 approval_required. */
export function proposeOnly(res: Response, approvals: ApprovalService, actor: ActorContext, target: { kind: string; id: string; action: 'ACTIVATE' | 'DELETE' }, approval: ApprovalRequest | undefined) {
  return approvalResponse(res, requestApproval(approvals, actor, { objectKind: target.kind, objectId: target.id, action: target.action }, approval, null));
}
