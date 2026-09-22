import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { listMyPasskeys, listMySessions } from '@/lib/api/account';
import { fetchSecurity } from '@/lib/api/auth';
import { requireSession } from '@/lib/session';
import { ChangePasswordForm } from './change-password-form';
import { MfaEnrollment } from './mfa-enrollment';
import { PasskeysCard } from './passkeys-card';
import { SessionsCard } from './sessions-card';
import { TwoFactorManage } from './two-factor-manage';

/** Account security (ADR-025): everything here acts on the signed-in user only. */
export async function AccountSecurity() {
  const session = await requireSession();
  const [security, sessions, passkeys] = await Promise.all([fetchSecurity(), listMySessions(), listMyPasskeys()]);
  const timeZone = session.user.deployment.timezone;
  const mfaOn = security.mfa?.enrolled ?? false;
  return (
    <div className="sec-grid">
      <section className="ch sec-card" aria-label="Password settings">
        <SecHead title="Password" desc={security.hasPassword ? 'current password required · other sessions sign out' : undefined} />
        {security.hasPassword ? (
          <ChangePasswordForm />
        ) : (
          <span className="mono-sm">You sign in with single sign-on or a passkey; this account has no password.</span>
        )}
      </section>
      <section className="ch sec-card" aria-label="Two-factor authentication">
        <SecHead
          title="Two-factor authentication"
          actions={<StatusChip tone={mfaOn ? 'good' : security.mfa?.required ? 'warn' : 'muted'}>{mfaOn ? 'on' : security.mfa?.required ? 'required' : 'off'}</StatusChip>}
        />
        <MfaEnrollment hasPassword={security.hasPassword} enabled={mfaOn} whenEnabled={<TwoFactorManage hasPassword={security.hasPassword} required={security.mfa?.required ?? false} />} />
      </section>
      <PasskeysCard passkeys={passkeys} timeZone={timeZone} />
      <SessionsCard sessions={sessions} currentId={security.sessionId} timeZone={timeZone} />
    </div>
  );
}
