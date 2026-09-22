'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { WORKER_FORM_FIELDS, apiFieldErrors, changedFields, parseWorkerForm, type WorkerValues } from '@/components/system/worker-form';
import { ApiError, describeApiError } from '../api/errors';
import { loadWorkerSettings, updateWorkerSettings } from '../api/system';
import { getSession } from '../session';
import { field, type FormState } from './form-state';

/** PATCH /v1/settings/workers (system.configure — Platform Tech Admin). Bounds are the API's; its messages land on the fields. */
export async function updateWorkerSettingsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.SYSTEM_CONFIGURE)) {
    return { status: 'error', message: 'Only a Platform Tech Admin can change the worker configuration.' };
  }
  const raw = Object.fromEntries(WORKER_FORM_FIELDS.map((f) => [f.name, field(formData, f.name)]));
  const values = { ...raw, autoscalingEnabled: formData.get('autoscalingEnabled') === 'on' ? 'on' : '' };
  const parsed = parseWorkerForm(raw, formData.get('autoscalingEnabled') === 'on');
  if (!parsed.ok) return { status: 'error', fieldErrors: parsed.fieldErrors, values };

  try {
    const current = await loadWorkerSettings();
    const patch = changedFields(current as WorkerValues, parsed.values);
    if (Object.keys(patch).length === 0) return { status: 'success', message: 'Nothing changed.', values };
    await updateWorkerSettings(patch);
  } catch (err) {
    if (err instanceof ApiError && err.category === 'validation') {
      const { fieldErrors, rest } = apiFieldErrors(err.message);
      if (fieldErrors['targetUtilization']) fieldErrors['targetUtilization'] += ' (the API stores a fraction: 1 = 100%)';
      return {
        status: 'error',
        message: rest.length ? rest.join('; ') : 'The API rejected these values — see the highlighted fields.',
        fieldErrors,
        values,
      };
    }
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: 'Worker configuration saved · the worker leader applies it within seconds · change recorded in the audit log' };
}
