'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission, ROLES, ROLE_LABELS } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { createTeam } from '../api/teams';
import { createUser, resendInvite, sendPasswordReset } from '../api/users';
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

/** Result of inviting someone: the set-password link comes back only when email is not configured (log driver). */
export type InviteState = FormState & { inviteLink?: string; expiresAt?: string };

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

  const canManageAll = session.permissions.has(Permission.USERS_MANAGE);
  if (!canManageAll && parsed.data.role !== 'SERVICE') {
    return { status: 'error', fieldErrors: { role: 'Leads can create Service member accounts only.' }, values };
  }
  let created;
  try {
    created = await createUser(parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  const label = `${parsed.data.name} · ${ROLE_LABELS[parsed.data.role]}`;
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
