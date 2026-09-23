'use client';

import { useActionState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { forgotPasswordAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/form-state';
import { AuthField } from './auth-field';

/** "Forgot password?" → Better Auth /request-password-reset; the answer never reveals whether the address exists. */
export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState(forgotPasswordAction, IDLE);
  if (state.status === 'success') {
    return (
      <AlertBanner title="Check your email." style={{ margin: 0 }}>
        {state.message}
      </AlertBanner>
    );
  }
  return (
    <form action={action} noValidate aria-label="Reset password">
      {state.message ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <AuthField name="email" label="Work email" type="email" autoComplete="username" defaultValue={state.values?.['email'] ?? ''} error={state.fieldErrors?.['email']} autoFocus />
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Sending…' : 'Email me a reset link'}
      </button>
    </form>
  );
}
