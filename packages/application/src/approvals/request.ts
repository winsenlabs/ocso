import type { ApprovalAction } from '@ocso/domain';
import type { ActorContext } from '../shared/context.js';
import { approvalOpenError, approvalRequiredError } from './guard.js';
import type { ApprovalRequest } from './inputs.js';
import { ApprovalService } from './proposals.js';
import type { ProposalDetail } from './views.js';

/** What an approvable write endpoint did: applied it (a draft), or opened a proposal (202). */
export type ApprovalOutcome<T> = { kind: 'applied'; value: T } | { kind: 'proposed'; proposal: ProposalDetail };

export interface ApprovalTarget {
  objectKind: string;
  objectId: string;
  action: ApprovalAction;
  /** The request body to replay on activation (CREATE/UPDATE). */
  payload?: Record<string, unknown> | undefined;
}

/**
 * The submission UX of every approvable write (PM/research/11 §4.1). A draft
 * is written directly (`direct`). Once the write needs approval: without
 * `approval` → 409 approval_required `{objectKind, action, objectId}`; with
 * it → the proposal is created from the same body and returned (the endpoint
 * answers 202). An open proposal locks the object → 409 approval_open.
 *
 * This is the routing; enforcement stays in the service: `direct` calls
 * assertChangeAllowed inside its own transaction, so a race cannot slip past.
 * `direct` is null for writes that are always proposals (ACTIVATE, DELETE).
 */
export async function requestApproval<T>(
  approvals: ApprovalService,
  actor: ActorContext,
  target: ApprovalTarget,
  approval: ApprovalRequest | undefined,
  direct: (() => Promise<T>) | null,
): Promise<ApprovalOutcome<T>> {
  const gate = await approvals.gate(actor.principal!, target.objectKind, target.objectId, target.action);
  if (gate.openId) throw approvalOpenError(target.objectKind, target.objectId, gate.openId);
  if (!gate.needed && direct) return { kind: 'applied', value: await direct() };
  if (!approval) throw approvalRequiredError(target.objectKind, target.objectId, target.action);
  const proposal = await approvals.submit(actor, ApprovalService.commandFor({ objectKind: target.objectKind, objectId: target.objectId, action: target.action, payload: target.payload }, approval));
  return { kind: 'proposed', proposal };
}
