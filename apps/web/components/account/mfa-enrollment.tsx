'use client';

import { useActionState, type ReactNode } from 'react';
import { TextField } from '@/components/forms/field';
import { AlertBanner } from '@/components/ui/alert-banner';
import { confirmEnrollmentAction, startEnrollmentAction, type EnrollmentState } from '@/lib/actions/account';
import { IDLE } from '@/lib/actions/form-state';
import { BackupCodes } from './backup-codes';

const START: EnrollmentState = { status: 'idle', step: 'start' };

export interface MfaEnrollmentProps {
  hasPassword: boolean;
  /** Two-factor is already on: render `whenEnabled` (unless enrolment just finished here). */
  enabled: boolean;
  whenEnabled: ReactNode;
  doneHref?: string;
}

/**
 * Authenticator-app enrolment (TOTP): password → QR code + manual key →
 * first code → backup codes, shown once. Used by Account security and by the
 * forced enrolment page. It stays mounted when two-factor turns on, because
 * verifying refreshes the page (new session cookie) and the backup codes live
 * only in this component's state.
 */
export function MfaEnrollment({ hasPassword, enabled, whenEnabled, doneHref }: MfaEnrollmentProps) {
  const [started, start, starting] = useActionState(startEnrollmentAction, START);
  const [confirmed, confirm, confirming] = useActionState(confirmEnrollmentAction, IDLE);

  // Backup codes stay in this page's memory only: shown once, after the first code proves the app works.
  if (confirmed.status === 'success') {
    return (
      <div style={{ display: 'grid', gap: 12 }}>
        <AlertBanner title="Two-factor authentication is on.">Save these backup codes now. Each works once if you lose your phone; they are not shown again.</AlertBanner>
        <BackupCodes codes={started.backupCodes ?? []} />
        {doneHref ? (
          <a className="btn accent" href={doneHref} style={{ justifySelf: 'start' }}>
            I saved my backup codes — continue
          </a>
        ) : null}
      </div>
    );
  }

  if (enabled && started.step !== 'verify') return <>{whenEnabled}</>;

  if (started.step === 'verify') {
    return (
      <form action={confirm} noValidate aria-label="Verify authenticator" style={{ display: 'grid', gap: 12 }}>
        <div className="totp-setup">
          <div className="totp-qr">
            <img src={started.qr} alt="QR code for your authenticator app" />
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            <span className="mono-sm">Scan the code with an authenticator app (1Password, Google Authenticator, Microsoft Authenticator…), or type this key:</span>
            <code className="totp-key" aria-label="Setup key">
              {started.secret}
            </code>
            {confirmed.message ? (
              <AlertBanner tone="error" style={{ margin: 0 }}>
                {confirmed.message}
              </AlertBanner>
            ) : null}
            <TextField idPrefix="mfa" name="code" label="6-digit code from the app" autoComplete="one-time-code" error={confirmed.fieldErrors?.['code']} required />
            <button type="submit" className="btn accent" disabled={confirming} style={{ justifySelf: 'start' }}>
              {confirming ? 'Verifying…' : 'Verify and turn on'}
            </button>
          </div>
        </div>
      </form>
    );
  }

  return (
    <form action={start} noValidate aria-label="Set up two-factor authentication" style={{ display: 'grid', gap: 12 }}>
      {started.message ? (
        <AlertBanner tone="error" style={{ margin: 0 }}>
          {started.message}
        </AlertBanner>
      ) : null}
      {hasPassword ? <TextField idPrefix="mfa" name="password" label="Current password" type="password" autoComplete="current-password" required /> : null}
      <button type="submit" className="btn accent" disabled={starting} style={{ justifySelf: 'start' }}>
        {starting ? 'Preparing…' : 'Set up authenticator app'}
      </button>
    </form>
  );
}
