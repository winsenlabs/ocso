'use server';

import { refresh } from 'next/cache';
import { Permission, ROLES } from '@ocso/auth';
import { z } from 'zod';
import { changeUserPermissions } from '../api/permissions';
import { ApiError, describeApiError } from '../api/errors';
import { getSession } from '../session';

/**
 * Change someone's permissions (POST /v1/users/:id/permission-changes). The API
 * splits the change: reductions apply at once, always; what widens access needs
 * a checker's approval and, without a named checker, answers 409
 * approval_required — surfaced here as its own outcome, not as a failure.
 */
export type PermissionChangeOutcome =
  | { kind: 'applied'; message: string }
  | { kind: 'proposed'; message: string }
  | { kind: 'approval_required'; message: string }
  | { kind: 'error'; message: string };

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('GRANT'), permission: z.enum(Permission), expiresOn: z.iso.date().nullable() }),
  z.object({ op: z.enum(['REVOKE', 'CLEAR']), permission: z.enum(Permission) }),
]);
const ChangeForm = z.object({
  userId: z.uuid(),
  preset: z.enum(ROLES).nullable(),
  changes: z.array(Op).max(50),
  reason: z.string().trim().min(3, 'Give a reason of at least 3 characters').max(500, 'At most 500 characters'),
  /** The checker named in the submit-for-approval modal (or bootstrap when nobody else can check). */
  approval: z.union([z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().max(500).optional() })]).nullable().default(null),
});
export type PermissionChangeForm = z.input<typeof ChangeForm>;

/** A date picked in the dialog expires at the end of that day, UTC. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`).toISOString();

export async function changePermissionsAction(raw: PermissionChangeForm): Promise<PermissionChangeOutcome> {
  if (!(await getSession())) return { kind: 'error', message: 'Your session has ended. Sign in again.' };
  const parsed = ChangeForm.safeParse(raw);
  if (!parsed.success) return { kind: 'error', message: parsed.error.issues[0]?.message ?? 'Check the change and try again.' };
  const { userId, preset, changes, reason, approval } = parsed.data;
  if (!changes.length && !preset) return { kind: 'error', message: 'Add at least one change.' };
  try {
    const result = await changeUserPermissions(userId, {
      ...(preset ? { preset } : {}),
      changes: changes.map((c) => (c.op === 'GRANT' ? { op: 'GRANT', permission: c.permission, expiresAt: c.expiresOn ? endOfDay(c.expiresOn) : null } : c)),
      reason,
      ...(approval ? { approval: 'bootstrap' in approval ? { bootstrap: true as const } : approval } : {}),
    });
    refresh();
    const ended = result.sessionsEnded ? ' · their sessions ended' : '';
    if (result.proposal) {
      return { kind: 'proposed', message: `${result.applied ? `Reductions applied at once${ended}; the rest was sent` : 'Sent'} for approval. It applies once the checker approves it.` };
    }
    return { kind: 'applied', message: result.direction === 'NONE' || !result.applied ? 'Nothing changed.' : `Applied at once${ended}.` };
  } catch (err) {
    if (err instanceof ApiError && err.code === 'approval_required') {
      // The API applies the reductions in a change even when the rest needs approval, and says so in the message.
      refresh();
      return { kind: 'approval_required', message: /reductions in this change were applied/.test(err.message) ? `${err.message}.` : `${err.message}. Nothing was changed.` };
    }
    return { kind: 'error', message: describeApiError(err) };
  }
}

/**
 * The submit-for-approval modal's write (PM/research/11 §3.6): the same change, now naming a checker. Answers in
 * the shape the approval interceptor expects: ok (proposed or applied) or the API's error code.
 */
export async function requestPermissionChangeAction(raw: PermissionChangeForm): Promise<{ ok: true; data: string } | { ok: false; message: string; code?: string | undefined }> {
  const outcome = await changePermissionsAction(raw);
  if (outcome.kind === 'applied' || outcome.kind === 'proposed') return { ok: true, data: outcome.message };
  return { ok: false, message: outcome.message, code: outcome.kind === 'approval_required' ? 'approval_required' : undefined };
}
