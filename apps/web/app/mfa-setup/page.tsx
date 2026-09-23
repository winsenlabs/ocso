import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { MfaEnrollment } from '@/components/account/mfa-enrollment';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { AlertBanner } from '@/components/ui/alert-banner';
import { logoutAction } from '@/lib/actions/auth';
import { fetchSecurity } from '@/lib/api/auth';
import { getSession, mfaPending } from '@/lib/session';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Set up two-factor authentication' };

/**
 * Forced enrolment (ADR-025): the Tech admin requires MFA for this user's role
 * and the session has no second factor yet. Nothing else in the app is
 * reachable until an authenticator app is set up.
 */
export default function MfaSetupPage() {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <MfaSetupContent />
      </Suspense>
    </main>
  );
}

async function MfaSetupContent() {
  const session = await getSession();
  if (!session) redirect('/login');
  // Verifying the first code refreshes this page with an upgraded session, so a satisfied
  // session renders the same component (which then shows the backup codes once).
  if (!session.mfa.required) redirect('/');
  const reauth = mfaPending(session) && session.mfa.enrolled;
  const security = await fetchSecurity();
  const signOut = (
    <form action={logoutAction}>
      <button type="submit" className="btn ghost tiny">
        Sign out
      </button>
    </form>
  );
  return (
    <AuthCard wide title="Set up two-factor authentication" sub={`${session.user.deployment.orgName} requires a second factor for ${session.roleLabel} accounts.`} foot={signOut}>
      {reauth ? (
        <AlertBanner tone="warn" title="Sign in again with your authenticator app.">
          Two-factor authentication is already on for your account, but this session started without it. Sign out, then sign in with your password and a code from the app.
        </AlertBanner>
      ) : (
        <MfaEnrollment
          hasPassword={security.hasPassword}
          doneHref="/"
          enabled={session.mfa.satisfied}
          whenEnabled={
            <a className="btn accent" href="/">
              Two-factor authentication is set up — continue
            </a>
          }
        />
      )}
    </AuthCard>
  );
}
