'use server';

import { refresh } from 'next/cache';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { parseQueueForm, parseSlaForm, type QueueFormFields, type SlaFormFields } from '@/components/queues/forms';
import { ApiError, describeApiError } from '../api/errors';
import { saveSlaPolicy, submitQueue, submitSlaPolicy, updateQueue, createQueue, type ApprovalBody, type Proposed, type QueueBaseline } from '../api/queues';
import { getSession } from '../session';

/**
 * Queue and SLA policy writes (docs/archive/specs/09 §3; PM/research/11 §4, §5.5). A new
 * queue or policy is a draft (applied directly); its first approval is a
 * separate submit. Once approved, a change answers `approval_required` and the
 * screen re-sends it with the maker's `approval` (a proposal). Removing a
 * transfer target or unlinking your team is a stop and applies at once. The
 * API is the enforcement point.
 */
export type QueueActionResult<T> = { ok: true; data: T } | { ok: false; message: string; code?: string | undefined; fieldErrors?: Record<string, string> | undefined };

const Id = z.uuid();
const Baseline = z.object({ teamIds: z.array(Id).max(50), transferTargetIds: z.array(Id).max(50) });
const Approval = z.union([z.object({ checkerId: Id, reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().min(3).max(500).optional() })]);

async function guard(permission: Permission, what: string): Promise<string | null> {
  const session = await getSession();
  if (!session) return 'Your session has ended. Sign in again.';
  return session.permissions.has(permission) ? null : `Your role cannot ${what}.`;
}

async function call<T>(permission: Permission, what: string, fn: () => Promise<T>): Promise<QueueActionResult<T>> {
  const denied = await guard(permission, what);
  if (denied) return { ok: false, message: denied };
  try {
    const data = await fn();
    refresh();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
}

function approvalOf(raw: unknown): ApprovalBody | undefined | 'invalid' {
  if (raw === undefined) return undefined;
  const parsed = Approval.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
}

/** POST /v1/queues (a draft), or PATCH /v1/queues/:id — a proposal once the queue is approved. */
export async function saveQueueAction(id: string | null, fields: QueueFormFields, approval?: unknown, baseline?: QueueBaseline): Promise<QueueActionResult<{ proposed: Proposed; created: string | null }>> {
  const parsed = parseQueueForm(fields);
  if (!parsed.ok) return { ok: false, message: 'Check the highlighted fields.', fieldErrors: parsed.fieldErrors };
  const choice = approvalOf(approval);
  if (choice === 'invalid') return { ok: false, message: 'Name a checker and give a reason of at least 3 characters.' };
  if (id !== null && !Id.safeParse(id).success) return { ok: false, message: 'Unknown queue.' };
  return call(Permission.QUEUES_MANAGE, 'manage queues', async () => {
    if (!id) return { proposed: null, created: await createQueue(parsed.data) };
    const seen = baseline ? Baseline.safeParse(baseline) : null;
    return { proposed: await updateQueue(id, parsed.data, choice, seen?.success ? seen.data : undefined), created: null };
  });
}

/** A draft queue's first approval (CREATE): routers may use it once a checker approves. */
export async function submitQueueAction(id: string, approval?: unknown): Promise<QueueActionResult<Proposed>> {
  const choice = approvalOf(approval);
  if (!Id.safeParse(id).success) return { ok: false, message: 'Unknown queue.' };
  if (!choice || choice === 'invalid') return { ok: false, message: 'This needs approval: name a checker and give a reason.', code: 'approval_required' };
  return call(Permission.QUEUES_MANAGE, 'submit queues for approval', () => submitQueue(id, choice));
}

/** POST /v1/sla-policies (a draft), or PUT /v1/sla-policies/:id — a proposal once the policy is approved. */
export async function saveSlaPolicyAction(id: string | null, fields: SlaFormFields, approval?: unknown): Promise<QueueActionResult<{ proposed: Proposed }>> {
  const parsed = parseSlaForm(fields);
  if (!parsed.ok) return { ok: false, message: 'Check the highlighted fields.', fieldErrors: parsed.fieldErrors };
  const choice = approvalOf(approval);
  if (choice === 'invalid') return { ok: false, message: 'Name a checker and give a reason of at least 3 characters.' };
  if (id !== null && !Id.safeParse(id).success) return { ok: false, message: 'Unknown SLA policy.' };
  return call(Permission.SLA_MANAGE, 'manage SLA policies', async () => ({ proposed: (await saveSlaPolicy(id, parsed.data, choice)).proposed }));
}

export async function submitSlaPolicyAction(id: string, approval?: unknown): Promise<QueueActionResult<Proposed>> {
  const choice = approvalOf(approval);
  if (!Id.safeParse(id).success) return { ok: false, message: 'Unknown SLA policy.' };
  if (!choice || choice === 'invalid') return { ok: false, message: 'This needs approval: name a checker and give a reason.', code: 'approval_required' };
  return call(Permission.SLA_MANAGE, 'submit SLA policies for approval', () => submitSlaPolicy(id, choice));
}
