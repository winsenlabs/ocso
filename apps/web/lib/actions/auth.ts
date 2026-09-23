'use server';

import { redirect } from 'next/navigation';
import { z } from 'zod';
import { completeSetup, recoverAccount } from '../api/auth';
import { ApiError, describeApiError } from '../api/errors';
import { authMessage, callAuth, clearAuthCookies } from '../auth/better-auth';
import { TWO_FACTOR_COOKIE, safeNextPath } from '../session-cookie';
import { field, fieldErrorsFrom, type FormState } from './form-state';

/** Sign-in form state: `step: 'mfa'` once the password was right and a second factor is due. */
export type LoginState = FormState & { step?: 'password' | 'mfa' };

const LoginForm = z.object({
  email: z.email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter your password').max(256),
});

/**
 * Email + password through Better Auth's /sign-in/email (ADR-025). Its
 * Set-Cookie (session, or the two-factor challenge) is relayed to the browser.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = field(formData, 'email').trim();
  const parsed = LoginForm.safeParse({ email, password: field(formData, 'password') });
  if (!parsed.success) return { status: 'error', step: 'password', fieldErrors: fieldErrorsFrom(parsed.error.issues), values: { email } };
  const result = await callAuth<{ twoFactorRedirect?: boolean }>('/sign-in/email', { email: parsed.data.email, password: parsed.data.password, rememberMe: true });
  if (!result.ok) return { status: 'error', step: 'password', message: authMessage(result, 'Sign-in failed'), values: { email } };
  if (result.data?.twoFactorRedirect) return { status: 'idle', step: 'mfa', values: { email } };
  redirect(safeNextPath(field(formData, 'next')));
}

const CodeForm = z.object({ code: z.string().trim().min(6, 'Enter the code').max(32) });

/** Second step: the authenticator code (or a backup code) against the pending two-factor challenge. */
export async function verifyMfaAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const values = { email: field(formData, 'email') };
  const backup = field(formData, 'method') === 'backup';
  const parsed = CodeForm.safeParse({ code: field(formData, 'code').replace(/\s+/g, '') });
  if (!parsed.success) return { status: 'error', step: 'mfa', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
  const result = await callAuth(backup ? '/two-factor/verify-backup-code' : '/two-factor/verify-totp', { code: parsed.data.code }, { forwardCookies: [TWO_FACTOR_COOKIE] });
  if (!result.ok) {
    const expired = result.code === 'INVALID_TWO_FACTOR_COOKIE' || result.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE';
    return { status: 'error', step: expired ? 'password' : 'mfa', message: authMessage(result, 'Verification failed'), values };
  }
  redirect(safeNextPath(field(formData, 'next')));
}

/** Better Auth sign-out (deletes the session row, audited), then clear every auth cookie. */
export async function logoutAction(): Promise<void> {
  await callAuth('/sign-out', {}, { session: true });
  await clearAuthCookies();
  redirect('/login');
}

const EmailForm = z.object({ email: z.email('Enter a valid email address').max(320) });

/** "Forgot password?": always the same answer, whether or not the address exists. */
export async function forgotPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, 'email').trim();
  const parsed = EmailForm.safeParse({ email });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values: { email } };
  const result = await callAuth('/request-password-reset', { email: parsed.data.email });
  // Only rate limiting and outages are reported; anything else gets the same answer as success.
  if (!result.ok && (result.status === 429 || result.code === 'UNREACHABLE')) return { status: 'error', message: authMessage(result), values: { email } };
  return { status: 'success', message: 'If an account uses this address, a link to choose a new password is on its way. It works once and expires in an hour.' };
}

const SetPasswordForm = z
  .object({
    token: z.string().min(10, 'This link is incomplete').max(200),
    password: z.string().min(12, 'Use at least 12 characters').max(256, 'Use at most 256 characters'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'The passwords do not match' });

/** Invite acceptance and password reset: Better Auth's /reset-password consumes the single-use token. */
export async function setPasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const purpose = field(formData, 'purpose') === 'invite' ? 'invite' : 'reset';
  const parsed = SetPasswordForm.safeParse({ token: field(formData, 'token'), password: field(formData, 'password'), confirm: field(formData, 'confirm') });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  const result = await callAuth('/reset-password', { token: parsed.data.token, newPassword: parsed.data.password });
  if (!result.ok) return { status: 'error', message: authMessage(result, 'The password could not be set') };
  redirect(purpose === 'invite' ? '/login?invite=accepted' : '/login?reset=done');
}

const SetupForm = z.object({
  setupToken: z.string().trim().min(16, 'The setup token is at least 16 characters').max(200),
  orgName: z.string().trim().min(1, 'Enter the organization name').max(200),
  adminName: z.string().trim().min(1, 'Enter your name').max(200),
  adminEmail: z.email('Enter a valid email address').max(320),
  adminPassword: z.string().min(12, 'Use at least 12 characters').max(256),
  timezone: z.string().trim().min(1, 'Choose a timezone').max(64),
});

/** First-run setup (ADR-010): creates the first Tech admin, then sends them to sign in. */
export async function setupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = {
    orgName: field(formData, 'orgName'),
    adminName: field(formData, 'adminName'),
    adminEmail: field(formData, 'adminEmail').trim(),
    timezone: field(formData, 'timezone'),
  };
  const parsed = SetupForm.safeParse({ ...values, setupToken: field(formData, 'setupToken'), adminPassword: field(formData, 'adminPassword') });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
  try {
    await completeSetup(parsed.data);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'setup_already_completed') redirect('/login');
    return { status: 'error', message: describeApiError(err), values };
  }
  redirect('/login?setup=done');
}

const RecoverForm = z.object({
  recoveryToken: z.string().trim().min(32, 'The recovery token is at least 32 characters').max(512),
  email: z.email('Enter a valid email address').max(320),
  newPassword: z.string().min(12, 'Use at least 12 characters').max(256),
});

/** Break-glass recovery with OCSO_RECOVERY_TOKEN (ADR-025). */
export async function recoverAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const values = { email: field(formData, 'email').trim() };
  const parsed = RecoverForm.safeParse({ ...values, recoveryToken: field(formData, 'recoveryToken'), newPassword: field(formData, 'newPassword') });
  if (!parsed.success) return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values };
  try {
    await recoverAccount(parsed.data);
  } catch (err) {
    return { status: 'error', message: describeApiError(err), values };
  }
  redirect('/login?recovered=1');
}
