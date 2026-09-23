'use server';

import { refresh } from 'next/cache';
import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { z } from 'zod';
import { describeApiError } from '../api/errors';
import { updateDeploymentSettings } from '../api/settings';
import { getSession } from '../session';
import { field, fieldErrorsFrom, type FormState } from './form-state';

const DeploymentForm = z.object({
  orgName: z.string().trim().min(1, 'Enter the organization name').max(200),
  deploymentLabel: z.string().trim().min(1, 'Enter a label, e.g. PROD').max(40, 'At most 40 characters'),
  regionLabel: z.string().trim().max(60, 'At most 60 characters'),
  timezone: z.string().trim().min(1, 'Choose a timezone').max(64),
  residencyZone: z.string().trim().max(20, 'At most 20 characters'),
});

const TEXT_FIELDS = ['orgName', 'deploymentLabel', 'regionLabel', 'timezone', 'residencyZone'] as const;

/** PATCH /v1/settings/deployment (deployment_settings.manage — Platform Tech Admin). */
export async function updateDeploymentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE)) {
    return { status: 'error', message: 'Only a Platform Tech Admin can change deployment settings.' };
  }
  const values = Object.fromEntries(TEXT_FIELDS.map((k) => [k, field(formData, k)])) as Record<(typeof TEXT_FIELDS)[number], string>;
  const parsed = DeploymentForm.safeParse(values);
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };

  try {
    await updateDeploymentSettings({
      orgName: parsed.data.orgName,
      deploymentLabel: parsed.data.deploymentLabel,
      regionLabel: parsed.data.regionLabel || null,
      timezone: parsed.data.timezone,
      residencyZone: parsed.data.residencyZone || null,
      execsCanViewAiActive: formData.get('execsCanViewAiActive') === 'on',
      allowCrossProviderFallback: formData.get('allowCrossProviderFallback') === 'on',
      allowCrossRegionFallback: formData.get('allowCrossRegionFallback') === 'on',
    });
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  refresh();
  return { status: 'success', message: 'Deployment settings saved · change recorded in the audit log' };
}
