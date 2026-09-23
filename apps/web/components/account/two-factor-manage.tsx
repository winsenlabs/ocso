'use client';

import { useActionState } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { disableTwoFactorAction, regenerateBackupCodesAction, type BackupCodesState } from '@/lib/actions/account';
import { IDLE } from '@/lib/actions/form-state';
import { BackupCodes } from './backup-codes';

const NO_CODES: BackupCodesState = { status: 'idle' };

/** Two-factor is on: new backup codes, or turn it off (not offered when the role requires it). */
export function TwoFactorManage({ hasPassword, required }: { hasPassword: boolean; required: boolean }) {
  const [codes, regenerate, regenerating] = useActionState(regenerateBackupCodesAction, NO_CODES);
  const [disabled, disable, disabling] = useActionState(disableTwoFactorAction, IDLE);
  const password = (id: string) => (hasPassword ? <TextField idPrefix={id} name="password" label="Current password" type="password" autoComplete="current-password" required /> : null);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <span className="mono-sm">Sign-in with your password asks for a code from your authenticator app. Backup codes work once each.</span>
      <form action={regenerate} noValidate aria-label="New backup codes" style={{ display: 'grid', gap: 10 }}>
        {codes.message ? <AlertBanner tone="error" style={{ margin: 0 }}>{codes.message}</AlertBanner> : null}
        {codes.codes ? (
          <>
            <AlertBanner style={{ margin: 0 }}>Your old backup codes stopped working. Save these now; they are not shown again.</AlertBanner>
            <BackupCodes codes={codes.codes} />
          </>
        ) : (
          <>
            {password('bc')}
            <button type="submit" className="btn" disabled={regenerating} style={{ justifySelf: 'start' }}>
              {regenerating ? 'Generating…' : 'Generate new backup codes'}
            </button>
          </>
        )}
      </form>
      {required ? (
        <span className="mono-sm">Your role requires two-factor authentication, so it cannot be turned off.</span>
      ) : (
        <form action={disable} noValidate aria-label="Turn off two-factor" style={{ display: 'grid', gap: 10 }}>
          {disabled.message ? <AlertBanner tone={disabled.status === 'error' ? 'error' : 'info'} style={{ margin: 0 }}>{disabled.message}</AlertBanner> : null}
          {password('off')}
          <button type="submit" className="btn danger" disabled={disabling} style={{ justifySelf: 'start' }}>
            {disabling ? 'Turning off…' : 'Turn off two-factor'}
          </button>
        </form>
      )}
    </div>
  );
}
