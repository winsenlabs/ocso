'use client';

import { useActionState, useState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { verifyMfaAction, type LoginState } from '@/lib/actions/auth';
import { AuthField } from './auth-field';

const START: LoginState = { status: 'idle', step: 'mfa' };

/** Second sign-in step: a code from the authenticator app, or one of the backup codes. */
export function MfaStep({ next, email }: { next: string; email: string }) {
  const [state, action, pending] = useActionState(verifyMfaAction, START);
  const [backup, setBackup] = useState(false);
  if (state.step === 'password') {
    return (
      <AlertBanner tone="error" title="Sign-in expired." action={<a className="auth-link" href={`/login?next=${encodeURIComponent(next)}`}>Start again</a>}>
        {state.message}
      </AlertBanner>
    );
  }
  return (
    <form action={action} noValidate aria-label="Two-factor verification">
      <input type="hidden" name="next" value={next} />
      <input type="hidden" name="email" value={email} />
      <input type="hidden" name="method" value={backup ? 'backup' : 'totp'} />
      <p className="auth-sub" style={{ marginTop: -8 }}>
        {backup ? 'Enter one of your backup codes. Each code works once.' : `Enter the 6-digit code from your authenticator app for ${email}.`}
      </p>
      {state.message ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <div className="auth-code">
        <AuthField
          key={backup ? 'backup' : 'totp'}
          name="code"
          label={backup ? 'Backup code' : 'Authentication code'}
          autoComplete="one-time-code"
          error={state.fieldErrors?.['code']}
          autoFocus
        />
      </div>
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Verifying…' : 'Verify'}
      </button>
      <div className="auth-links">
        <button type="button" className="btn ghost tiny" onClick={() => setBackup((b) => !b)}>
          {backup ? 'Use the authenticator app' : 'Use a backup code'}
        </button>
        <a className="auth-link" href="/login">
          Cancel
        </a>
      </div>
    </form>
  );
}
