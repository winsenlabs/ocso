import 'server-only';
import { z } from 'zod';
import type { EmailSettings, EmailTestResult } from '../email-settings-form';
import { api } from './client';

/** Driver names are open (any registered EMAIL_DRIVER); the API sends its display label too. */
const Driver = z.string();

/** GET /v1/settings/email (deployment_settings.manage). Configured by the deployment; never includes secrets. */
export const EmailSettingsSchema = z.object({
  driver: Driver,
  label: z.string().optional(),
  from: z.string().nullable(),
  replyTo: z.string().nullable(),
  configured: z.boolean(),
  warnings: z.array(z.string()),
}) satisfies z.ZodType<EmailSettings>;

/** POST /v1/settings/email/test. `category` stays open-ended so a new API category never breaks the page. */
export const EmailTestResultSchema = z.object({
  ok: z.boolean(),
  driver: Driver,
  label: z.string().optional(),
  delivers: z.boolean().optional(),
  id: z.string().nullable(),
  error: z.string().optional(),
  category: z.string().optional(),
  retriable: z.boolean().optional(),
  warning: z.string().optional(),
}) satisfies z.ZodType<EmailTestResult>;

export function getEmailSettings(): Promise<EmailSettings> {
  return api.get('/v1/settings/email', EmailSettingsSchema);
}

/** Sends one test email with the deployment's current configuration. */
export function sendTestEmail(to: string): Promise<EmailTestResult> {
  return api.post('/v1/settings/email/test', { to }, EmailTestResultSchema, { timeoutMs: 20_000 });
}
