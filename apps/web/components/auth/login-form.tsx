'use client';

import { useActionState } from 'react';
import Link from 'next/link';
import { AlertBanner } from '@/components/ui/alert-banner';
import { loginAction, type LoginState } from '@/lib/actions/auth';
import { AlternativeSignIn } from './alternative-sign-in';
import { AuthField } from './auth-field';
import { MfaStep } from './mfa-step';

const START: LoginState = { status: 'idle', step: 'password' };

/**
 * Sign-in (ADR-025): email + password, then the authenticator step when the
 * account has two-factor; passkeys and SSO start in the browser.
 */
export function LoginForm({ next, sso }: { next: string; sso: boolean }) {
  const [state, action, pending] = useActionState(loginAction, START);
  if (state.step === 'mfa') return <MfaStep next={next} email={state.values?.['email'] ?? ''} />;
  const errors = state.fieldErrors ?? {};
  return (
    <>
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
          autoComplete="username webauthn"
          defaultValue={state.values?.['email'] ?? ''}
          error={errors['email']}
          autoFocus
        />
        <AuthField name="password" label="Password" type="password" autoComplete="current-password" error={errors['password']} />
        <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
          {pending ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="auth-links">
          <Link href="/forgot-password">Forgot password?</Link>
        </div>
      </form>
      <AlternativeSignIn next={next} sso={sso} />
    </>
  );
}
