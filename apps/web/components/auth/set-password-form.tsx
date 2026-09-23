'use client';

import { useActionState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { setPasswordAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/form-state';
import { AuthField } from './auth-field';

/**
 * Choose a password with a single-use link: accepting an invite or resetting a
 * forgotten password (Better Auth /reset-password; other sessions end).
 */
export function SetPasswordForm({ token, purpose }: { token: string; purpose: 'invite' | 'reset' }) {
  const [state, action, pending] = useActionState(setPasswordAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} noValidate aria-label={purpose === 'invite' ? 'Accept invite' : 'Choose a new password'}>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="purpose" value={purpose} />
      {state.message || errors['token'] ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message ?? errors['token']}
        </AlertBanner>
      ) : null}
      <AuthField name="password" label="New password" type="password" autoComplete="new-password" error={errors['password']} hint="at least 12 characters; a passphrase works well" autoFocus />
      <AuthField name="confirm" label="Confirm password" type="password" autoComplete="new-password" error={errors['confirm']} />
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Saving…' : purpose === 'invite' ? 'Set password and continue' : 'Set new password'}
      </button>
    </form>
  );
}
