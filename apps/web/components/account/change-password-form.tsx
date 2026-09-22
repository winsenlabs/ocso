'use client';

import { useActionState } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { changePasswordAction } from '@/lib/actions/account';
import { IDLE } from '@/lib/actions/form-state';

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState(changePasswordAction, IDLE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={action} noValidate aria-label="Change password" style={{ display: 'grid', gap: 12 }}>
      {state.message ? (
        <AlertBanner tone={state.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>
          {state.message}
        </AlertBanner>
      ) : null}
      <TextField idPrefix="pw" name="currentPassword" label="Current password" type="password" autoComplete="current-password" error={errors['currentPassword']} required />
      <TextField idPrefix="pw" name="newPassword" label="New password" type="password" autoComplete="new-password" error={errors['newPassword']} hint="at least 12 characters" required />
      <TextField idPrefix="pw" name="confirm" label="Confirm new password" type="password" autoComplete="new-password" error={errors['confirm']} required />
      <button type="submit" className="btn accent" disabled={pending} style={{ justifySelf: 'start' }}>
        {pending ? 'Changing…' : 'Change password'}
      </button>
    </form>
  );
}
