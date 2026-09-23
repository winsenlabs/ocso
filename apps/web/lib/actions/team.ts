'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission, ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '@ocso/auth';
import { z } from 'zod';
import { ApiError, describeApiError } from '../api/errors';
import { createTeam } from '../api/teams';
import { createUser, discardUser, resendInvite, sendPasswordReset, submitUserCreation } from '../api/users';
import { getSession } from '../session';
import { field, fieldErrorsFrom, type FormState } from './form-state';

const CreateUserForm = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  email: z.email('Enter a valid email address').max(320),
  role: z.enum(ROLES, 'Choose a role'),
  teamIds: z.array(z.uuid()).max(50),
  languages: z.array(z.string().max(20, 'Language codes are at most 20 characters')).max(20),
  maxConcurrent: z.coerce.number('Enter a number').int().min(1, 'At least 1').max(50, 'At most 50'),
});

/**
 * Result of inviting someone: the set-password link comes back only when email is not configured (log driver).
 * `pendingUser`: created pending approval — the dialog then asks for a checker (PM/research/11 §3.4).
 */
export type InviteState = FormState & { inviteLink?: string; expiresAt?: string; pendingUser?: { id: string; name: string; role: string } };

/**
 * POST /v1/users: invites the user (ADR-025) — they choose their own password
 * through a single-use link. The API decides who may create which role; the
 * form only offers allowed roles.
 */
export async function createUserAction(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const session = await getSession();
  if (!session) redirect('/login');
  const values = { name: field(formData, 'name'), email: field(formData, 'email').trim(), role: field(formData, 'role'), languages: field(formData, 'languages'), maxConcurrent: field(formData, 'maxConcurrent') };
  const parsed = CreateUserForm.safeParse({
    ...values,
    teamIds: formData.getAll('teamIds').filter((v): v is string => typeof v === 'string'),
    languages: values.languages.split(',').map((l) => l.trim()).filter(Boolean),
  });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };

  // Containment (PM/research/11 §3.4): without users.manage, only presets whose rights fit inside your own.
  const canManageAll = session.permissions.has(Permission.USERS_MANAGE);
  if (!canManageAll && ![...ROLE_PERMISSIONS[parsed.data.role]].every((p) => session.permissions.has(p))) {
    return { status: 'error', fieldErrors: { role: 'You can create colleagues whose rights do not exceed yours.' }, values };
  }
  // A new user must land in one of your teams unless you manage everyone (the API refuses it otherwise).
  if (!canManageAll && !parsed.data.teamIds.some((t) => session.user.teamIds.includes(t))) {
    return { status: 'error', fieldErrors: { teamIds: 'Place them in at least one of your teams.' }, values };
  }
  let created;
  try {
    created = await createUser(parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  const label = `${parsed.data.name} · ${ROLE_LABELS[parsed.data.role]}`;
  if (created.onboarding.kind === 'pending_approval') {
    return {
      status: 'success',
      message: `Created ${label} · pending approval: they can sign in once a checker approves them`,
      pendingUser: { id: created.id, name: parsed.data.name, role: ROLE_LABELS[parsed.data.role] },
    };
  }
  if (created.onboarding.kind !== 'invite') return { status: 'success', message: `Created ${label}` };
  const { delivery, link, expiresAt } = created.onboarding;
  if (link) return { status: 'success', message: `Invited ${label}`, inviteLink: link, expiresAt };
  return delivery.delivered
    ? { status: 'success', message: `Invited ${label} · invite emailed` }
    : { status: 'success', message: `Created ${label}, but the invite email failed (${delivery.error ?? 'unknown error'}). Use Resend invite.` };
}

export type AccessLinkResult = { ok: true; message: string; link: string | null } | { ok: false; message: string };

/** Resend an invite (the old link stops working) or send a password-reset link to someone else. */
export async function userAccessAction(userId: string, kind: 'invite' | 'reset'): Promise<AccessLinkResult> {
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    const result = kind === 'invite' ? (await resendInvite(userId)).onboarding : await sendPasswordReset(userId);
    if (!('delivery' in result)) return { ok: true, message: 'Done', link: null };
    if (result.link) return { ok: true, message: 'Email is not configured here: copy this link and hand it over. It works once.', link: result.link };
    return result.delivery.delivered
      ? { ok: true, message: kind === 'invite' ? 'Invite emailed again.' : 'Password reset link emailed.', link: null }
      : { ok: false, message: `The email could not be sent: ${result.delivery.error ?? 'unknown error'}` };
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
}

const UserApproval = z.union([z.object({ checkerId: z.uuid(), reason: z.string().trim().min(3).max(500) }), z.object({ bootstrap: z.literal(true), reason: z.string().trim().max(500).optional() })]);

/**
 * Submit a pending user's creation to a checker (PATCH /v1/users/:id { approval }): 202 with the proposal. The
 * checker holds approvals.check.permissions and is never the maker nor the new user; on approval they become
 * active and the invite is sent.
 */
export async function submitPendingUserAction(userId: string, approval?: z.input<typeof UserApproval>): Promise<{ ok: true; data: null } | { ok: false; message: string; code?: string | undefined }> {
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  const parsed = z.object({ userId: z.uuid(), approval: UserApproval.optional() }).safeParse({ userId, approval });
  if (!parsed.success) return { ok: false, message: 'Name a checker and give a reason.' };
  try {
    await submitUserCreation(parsed.data.userId, parsed.data.approval);
  } catch (err) {
    return { ok: false, message: describeApiError(err), code: err instanceof ApiError ? err.code : undefined };
  }
  refresh();
  return { ok: true, data: null };
}

/** Discard a user whose creation was never approved (DELETE /v1/users/:id). */
export async function discardUserAction(userId: string): Promise<{ ok: boolean; message: string }> {
  if (!(await getSession())) return { ok: false, message: 'Your session has ended. Sign in again.' };
  try {
    await discardUser(userId);
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
  refresh();
  return { ok: true, message: 'Discarded.' };
}

const CreateTeamForm = z.object({
  name: z.string().trim().min(1, 'Enter a team name').max(120),
  description: z.string().trim().max(500, 'At most 500 characters'),
});

/** POST /v1/teams (teams.manage). */
export async function createTeamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await getSession())) redirect('/login');
  const values = { name: field(formData, 'name'), description: field(formData, 'description') };
  const parsed = CreateTeamForm.safeParse(values);
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
  try {
    await createTeam({ name: parsed.data.name, description: parsed.data.description || null });
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: `Created team ${parsed.data.name}` };
}
