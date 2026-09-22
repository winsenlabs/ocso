'use server';

import { redirect } from 'next/navigation';
import { Permission } from '@ocso/auth';
import { describeApiError } from '../api/errors';
import { sendTestEmail } from '../api/email-settings';
import { describeTestResult, parseTestRecipient, type EmailTestState } from '../email-settings-form';
import { getSession } from '../session';
import { field } from './form-state';

/** POST /v1/settings/email/test (deployment_settings.manage — Platform Tech Admin). */
export async function sendTestEmailAction(_prev: EmailTestState, formData: FormData): Promise<EmailTestState> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.permissions.has(Permission.DEPLOYMENT_SETTINGS_MANAGE)) {
    return { status: 'error', tone: 'error', message: 'Only a Platform Tech Admin can send test emails.' };
  }
  const raw = field(formData, 'to');
  const parsed = parseTestRecipient(raw);
  if (!parsed.ok) return { status: 'error', fieldErrors: { to: parsed.error }, values: { to: raw } };

  try {
    const result = await sendTestEmail(parsed.to);
    const notice = describeTestResult(result);
    return { status: result.ok ? 'success' : 'error', tone: notice.tone, message: notice.message, values: { to: parsed.to } };
  } catch (err) {
    return { status: 'error', tone: 'error', message: describeApiError(err), values: { to: parsed.to } };
  }
}
