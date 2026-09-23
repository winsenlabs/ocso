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
  checkerId: z.uuid().nullable(),
});
export type PermissionChangeForm = z.input<typeof ChangeForm>;

/** A date picked in the dialog expires at the end of that day, UTC. */
const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`).toISOString();

export async function changePermissionsAction(raw: PermissionChangeForm): Promise<PermissionChangeOutcome> {
  if (!(await getSession())) return { kind: 'error', message: 'Your session has ended. Sign in again.' };
  const parsed = ChangeForm.safeParse(raw);
  if (!parsed.success) return { kind: 'error', message: parsed.error.issues[0]?.message ?? 'Check the change and try again.' };
  const { userId, preset, changes, reason, checkerId } = parsed.data;
  if (!changes.length && !preset) return { kind: 'error', message: 'Add at least one change.' };
  try {
    const result = await changeUserPermissions(userId, {
      ...(preset ? { preset } : {}),
      changes: changes.map((c) => (c.op === 'GRANT' ? { op: 'GRANT', permission: c.permission, expiresAt: c.expiresOn ? endOfDay(c.expiresOn) : null } : c)),
      reason,
      ...(checkerId ? { approval: { checkerId } } : {}),
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
