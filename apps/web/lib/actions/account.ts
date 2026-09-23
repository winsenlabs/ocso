'use server';

import { refresh } from 'next/cache';
import { renderSVG } from 'uqr';
import { z } from 'zod';
import { authMessage, callAuth } from '../auth/better-auth';
import { field, fieldErrorsFrom, type FormState } from './form-state';

/**
 * Account security (ADR-025): the signed-in user's own password, two-factor,
 * sessions and passkeys, all through Better Auth's endpoints with the session
 * as Bearer. Better Auth audits nothing itself; OCSO's policy plugin does.
 */

export type EnrollmentState = FormState & {
  step: 'start' | 'verify' | 'done';
  /** QR code (SVG data URL) and manual key for the authenticator app. */
  qr?: string;
  secret?: string;
  backupCodes?: string[];
};

export async function startEnrollmentAction(_prev: EnrollmentState, formData: FormData): Promise<EnrollmentState> {
  const password = field(formData, 'password');
  const result = await callAuth<{ totpURI: string; backupCodes: string[] }>('/two-factor/enable', password ? { password } : {}, { session: true });
  if (!result.ok || !result.data) return { status: 'error', step: 'start', message: authMessage(result, 'Two-factor authentication could not be started') };
  const svg = renderSVG(result.data.totpURI, { border: 1 });
  return {
    status: 'idle',
    step: 'verify',
    qr: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
    secret: new URL(result.data.totpURI).searchParams.get('secret') ?? '',
    backupCodes: result.data.backupCodes,
  };
}

const Code = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') });

/** First code from the app: turns two-factor on and upgrades this session (new cookie relayed). */
export async function confirmEnrollmentAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = Code.safeParse({ code: field(formData, 'code').replace(/\s+/g, '') });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  const result = await callAuth('/two-factor/verify-totp', { code: parsed.data.code }, { session: true });
  if (!result.ok) return { status: 'error', message: authMessage(result, 'That code did not work') };
  return { status: 'success' };
}

export async function disableTwoFactorAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = field(formData, 'password');
  const result = await callAuth('/two-factor/disable', password ? { password } : {}, { session: true });
  if (!result.ok) return { status: 'error', message: authMessage(result, 'Two-factor authentication could not be turned off') };
  refresh();
  return { status: 'success', message: 'Two-factor authentication is off.' };
}

export type BackupCodesState = FormState & { codes?: string[] };

export async function regenerateBackupCodesAction(_prev: BackupCodesState, formData: FormData): Promise<BackupCodesState> {
  const password = field(formData, 'password');
  const result = await callAuth<{ backupCodes: string[] }>('/two-factor/generate-backup-codes', password ? { password } : {}, { session: true });
  if (!result.ok || !result.data) return { status: 'error', message: authMessage(result, 'New backup codes could not be generated') };
  return { status: 'success', codes: result.data.backupCodes };
}

const ChangePassword = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password').max(256),
    newPassword: z.string().min(12, 'Use at least 12 characters').max(256),
    confirm: z.string(),
  })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

/** Current password required; every other session ends (this one gets a fresh cookie). */
export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = ChangePassword.safeParse({ currentPassword: field(formData, 'currentPassword'), newPassword: field(formData, 'newPassword'), confirm: field(formData, 'confirm') });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  const result = await callAuth('/change-password', { currentPassword: parsed.data.currentPassword, newPassword: parsed.data.newPassword, revokeOtherSessions: true }, { session: true });
  if (!result.ok) return { status: 'error', message: authMessage(result, 'The password could not be changed') };
  refresh();
  return { status: 'success', message: 'Password changed. Your other sessions were signed out.' };
}

export type ActionResult = { ok: true; message: string } | { ok: false; message: string };

/** Sign out one session: its token is looked up server-side and never sent to the browser. */
export async function revokeSessionAction(sessionId: string): Promise<ActionResult> {
  const list = await callAuth<Array<{ id: string; token: string }>>('/list-sessions', undefined, { method: 'GET', session: true, relay: false });
  const token = list.data?.find((s) => s.id === sessionId)?.token;
  if (!token) return { ok: false, message: 'That session has already ended.' };
  const result = await callAuth('/revoke-session', { token }, { session: true });
  if (!result.ok) return { ok: false, message: authMessage(result) };
  refresh();
  return { ok: true, message: 'Session signed out.' };
}

export async function revokeOtherSessionsAction(): Promise<ActionResult> {
  const result = await callAuth('/revoke-other-sessions', {}, { session: true });
  if (!result.ok) return { ok: false, message: authMessage(result) };
  refresh();
  return { ok: true, message: 'All your other sessions were signed out.' };
}

export async function deletePasskeyAction(id: string): Promise<ActionResult> {
  const result = await callAuth('/passkey/delete-passkey', { id }, { session: true });
  if (!result.ok) return { ok: false, message: authMessage(result) };
  refresh();
  return { ok: true, message: 'Passkey removed.' };
}
