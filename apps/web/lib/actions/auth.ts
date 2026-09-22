'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { completeSetup, login, logout } from '../api/auth';
import { ApiError, describeApiError } from '../api/errors';
import { SESSION_COOKIE, safeNextPath, sessionCookieOptions } from '../session-cookie';
import { field, fieldErrorsFrom, type FormState } from './form-state';
import { clientIp } from '../client-ip';

const LoginForm = z.object({
  email: z.email('Enter a valid email address').max(320),
  password: z.string().min(1, 'Enter your password').max(256),
});

/** POST /v1/auth/login, then store the token in the httpOnly session cookie (ADR-020). */
export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const email = field(formData, 'email').trim();
  const parsed = LoginForm.safeParse({ email, password: field(formData, 'password') });
  if (!parsed.success) {
    return { status: 'error', fieldErrors: fieldErrorsFrom(parsed.error.issues), values: { email } };
  }
  try {
    const session = await login(parsed.data.email, parsed.data.password, await clientIp());
    (await cookies()).set(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));
  } catch (err) {
    return { status: 'error', message: loginMessage(err), values: { email } };
  }
  redirect(safeNextPath(field(formData, 'next')));
}

/** Revoke the API session (best effort) and clear the cookie. */
export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await logout(token);
    } catch {
      // The session may already be expired or revoked; clearing the cookie is what matters here.
    }
  }
  jar.delete(SESSION_COOKIE);
  redirect('/login');
}

const SetupForm = z.object({
  setupToken: z.string().trim().min(16, 'The setup token is at least 16 characters').max(200),
  orgName: z.string().trim().min(1, 'Enter the organization name').max(200),
  adminName: z.string().trim().min(1, 'Enter your name').max(200),
  adminEmail: z.email('Enter a valid email address').max(320),
  adminPassword: z.string().min(12, 'Use at least 12 characters').max(256),
  timezone: z.string().trim().min(1, 'Choose a timezone').max(64),
});

/** First-run setup (ADR-010): creates the first Platform Tech Admin, then sends them to sign in. */
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

function loginMessage(err: unknown): string {
  if (err instanceof ApiError && err.category === 'validation') return 'Enter a valid email address and password.';
  return describeApiError(err);
}
