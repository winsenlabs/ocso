'use client';

import { useActionState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { loginAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/form-state';
import { AuthField } from './auth-field';

/** Email + password sign-in; errors come straight from the API. */
export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(loginAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} noValidate aria-label="Sign in">
      <input type="hidden" name="next" value={next} />
      {state.message ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <AuthField
        name="email"
        label="Work email"
        type="email"
        autoComplete="username"
        defaultValue={state.values?.['email'] ?? ''}
        error={errors['email']}
        autoFocus
      />
      <AuthField name="password" label="Password" type="password" autoComplete="current-password" error={errors['password']} />
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
