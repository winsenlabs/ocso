'use client';

import { useActionState } from 'react';
import { AlertBanner } from '@/components/ui/alert-banner';
import { recoverAction } from '@/lib/actions/auth';
import { IDLE } from '@/lib/actions/form-state';
import { AuthField } from './auth-field';

/** Break-glass recovery for a locked-out Platform Tech Admin (OCSO_RECOVERY_TOKEN). */
export function RecoverForm() {
  const [state, action, pending] = useActionState(recoverAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} noValidate aria-label="Account recovery">
      {state.message ? (
        <AlertBanner tone="error" style={{ marginBottom: 14 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <AuthField name="recoveryToken" label="Recovery token" autoComplete="off" mono error={errors['recoveryToken']} hint="the value of OCSO_RECOVERY_TOKEN; it works once" autoFocus />
      <AuthField name="email" label="Tech Admin email" type="email" autoComplete="username" defaultValue={state.values?.['email'] ?? ''} error={errors['email']} />
      <AuthField name="newPassword" label="New password" type="password" autoComplete="new-password" error={errors['newPassword']} hint="at least 12 characters" />
      <button className="btn accent" type="submit" disabled={pending} style={{ marginTop: 4 }}>
        {pending ? 'Recovering…' : 'Reset password and sign-in factors'}
      </button>
    </form>
  );
}
