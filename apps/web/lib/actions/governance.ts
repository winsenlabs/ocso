'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { describeApiError } from '../api/errors';
import { updateGovernance } from '../api/governance';
import { getSession } from '../session';
import type { FormState } from './form-state';

async function requireManager(): Promise<FormState | null> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE) ? null : { status: 'error', message: 'Only a Tech admin can change these settings.' };
}

/** PATCH /v1/settings/deployment { retention } — the API enforces per-class floors. */
export async function updateRetentionAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const denied = await requireManager();
  if (denied) return denied;
  const retention: Record<string, number> = {};
  const fieldErrors: Record<string, string> = {};
  for (const [name, raw] of formData.entries()) {
    if (!name.startsWith('days:')) continue;
    const key = name.slice(5);
    const days = Number(String(raw).trim());
    if (!Number.isInteger(days) || days < 1 || days > 3650) fieldErrors[name] = 'Whole days between 1 and 3650';
    else retention[key] = days;
  }
  if (Object.keys(fieldErrors).length) return { status: 'error', fieldErrors };
  try {
    await updateGovernance({ retention });
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
  refresh();
  return { status: 'success', message: 'Retention saved · applied by the worker within the hour · recorded in the audit log' };
}

/** PATCH /v1/settings/deployment { internalAgentProfileId, internalAgentConfirmLowWrites }. */
export async function updateAssistantAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const denied = await requireManager();
  if (denied) return denied;
  const profile = String(formData.get('internalAgentProfileId') ?? '');
  try {
    await updateGovernance({ internalAgentProfileId: profile || null, internalAgentConfirmLowWrites: formData.get('internalAgentConfirmLowWrites') === 'on' });
  } catch (err) {
    return { status: 'error', message: describeApiError(err) };
  }
  refresh();
  return { status: 'success', message: 'Ask OCSO settings saved' };
}
