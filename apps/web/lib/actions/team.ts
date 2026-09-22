'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission, ROLES, ROLE_LABELS } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { createTeam } from '../api/teams';
import { createUser } from '../api/users';
import { getSession } from '../session';
import { field, fieldErrorsFrom, type FormState } from './form-state';

const CreateUserForm = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(200),
  email: z.email('Enter a valid email address').max(320),
  role: z.enum(ROLES, 'Choose a role'),
  password: z.string().min(12, 'Use at least 12 characters').max(256),
  teamIds: z.array(z.uuid()).max(50),
  languages: z.array(z.string().max(20, 'Language codes are at most 20 characters')).max(20),
  maxConcurrent: z.coerce.number('Enter a number').int().min(1, 'At least 1').max(50, 'At most 50'),
});

/** POST /v1/users. The API decides who may create which role; the form only offers allowed roles. */
export async function createUserAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect('/login');
  const values = { name: field(formData, 'name'), email: field(formData, 'email').trim(), role: field(formData, 'role'), languages: field(formData, 'languages'), maxConcurrent: field(formData, 'maxConcurrent') };
  const parsed = CreateUserForm.safeParse({
    ...values,
    password: field(formData, 'password'),
    teamIds: formData.getAll('teamIds').filter((v): v is string => typeof v === 'string'),
    languages: values.languages.split(',').map((l) => l.trim()).filter(Boolean),
  });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };

  const canManageAll = session.permissions.has(Permission.USERS_MANAGE);
  if (!canManageAll && parsed.data.role !== 'CS_EXEC') {
    return { status: 'error', fieldErrors: { role: 'CS Leads can create CS Exec accounts only.' }, values };
  }
  try {
    await createUser(parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: `Created ${parsed.data.name} · ${ROLE_LABELS[parsed.data.role]}` };
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
