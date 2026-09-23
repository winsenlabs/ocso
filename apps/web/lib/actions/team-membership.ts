'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { addTeamMember, removeTeamMember, updateTeam } from '../api/teams';
import { updateUserTeams } from '../api/users';
import { getSession } from '../session';
import { field, fieldErrorsFrom, type FormState } from './form-state';

/**
 * Team membership (ADR-026). The API decides who may change which membership
 * (Tech Admin: all; CS Lead: CS Execs and themselves on teams they belong to);
 * these actions only forward, and hand its refusals back to show inline.
 */
export type MembershipResult = { ok: true; message: string } | { ok: false; message: string };

const Id = z.uuid();
const SESSION_ENDED: MembershipResult = { ok: false, message: 'Your session has ended. Sign in again.' };

async function run(work: () => Promise<void>, message: string): Promise<MembershipResult> {
  try {
    await work();
  } catch (err) {
    return { ok: false, message: describeApiError(err) };
  }
  refresh();
  return { ok: true, message };
}

/** POST /v1/teams/:id/members. */
export async function addTeamMemberAction(teamId: string, userId: string, name: string): Promise<MembershipResult> {
  if (!(await getSession())) return SESSION_ENDED;
  if (!Id.safeParse(teamId).success || !Id.safeParse(userId).success) return { ok: false, message: 'Unknown team or user.' };
  return run(() => addTeamMember(teamId, userId), `Added ${name}`);
}

/** DELETE /v1/teams/:id/members/:userId. */
export async function removeTeamMemberAction(teamId: string, userId: string, name: string): Promise<MembershipResult> {
  if (!(await getSession())) return SESSION_ENDED;
  if (!Id.safeParse(teamId).success || !Id.safeParse(userId).success) return { ok: false, message: 'Unknown team or user.' };
  return run(() => removeTeamMember(teamId, userId), `Removed ${name}`);
}

/**
 * Replace a user's teams from the People table. PATCH /v1/users/:id is atomic
 * but manages other people only; a CS Lead's own memberships go through the
 * team member endpoints (they may leave their teams, not join others).
 */
export async function saveUserTeamsAction(userId: string, before: string[], after: string[]): Promise<MembershipResult> {
  const session = await getSession();
  if (!session) return SESSION_ENDED;
  const ids = z.array(Id).max(200);
  if (!Id.safeParse(userId).success || !ids.safeParse(before).success || !ids.safeParse(after).success) return { ok: false, message: 'Unknown team or user.' };
  const selfAsLead = userId === session.user.id && !session.permissions.has(Permission.USERS_MANAGE);
  if (!selfAsLead) return run(() => updateUserTeams(userId, [...new Set(after)]), 'Teams saved');
  return run(async () => {
    for (const teamId of after.filter((t) => !before.includes(t))) await addTeamMember(teamId, userId);
    for (const teamId of before.filter((t) => !after.includes(t))) await removeTeamMember(teamId, userId);
  }, 'Your teams are saved');
}

const TeamForm = z.object({
  id: Id,
  name: z.string().trim().min(1, 'Enter a team name').max(120, 'At most 120 characters'),
  description: z.string().trim().max(500, 'At most 500 characters'),
});

/** PATCH /v1/teams/:id (CS Leads, on teams they belong to). */
export async function updateTeamAction(_prev: FormState, formData: FormData): Promise<FormState> {
  if (!(await getSession())) redirect('/login');
  const values = { id: field(formData, 'id'), name: field(formData, 'name'), description: field(formData, 'description') };
  const parsed = TeamForm.safeParse(values);
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
  try {
    await updateTeam(parsed.data.id, { name: parsed.data.name, description: parsed.data.description || null });
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: `Saved ${parsed.data.name}` };
}
