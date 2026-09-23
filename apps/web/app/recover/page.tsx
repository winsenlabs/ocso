import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { RecoverForm } from '@/components/auth/recover-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import { fetchSetupStatus } from '@/lib/api/auth';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Account recovery' };

/** Break-glass recovery (ADR-025): available only while the operator sets OCSO_RECOVERY_TOKEN. */
export default function RecoverPage() {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <RecoverContent />
      </Suspense>
    </main>
  );
}

async function RecoverContent() {
  const status = await fetchSetupStatus().catch(() => null);
  return (
    <AuthCard
      wide
      title="Account recovery"
      sub="For a Tech admin who cannot sign in: resets the password, removes the authenticator app and ends every session. Audited."
      foot={<a className="auth-link" href="/login">back to sign-in</a>}
    >
      {status?.recovery ? (
        <RecoverForm />
      ) : (
        <AlertBanner tone="warn" title="Recovery is not enabled.">
          The operator enables it by setting OCSO_RECOVERY_TOKEN (at least 32 characters) on the API and restarting it. See docs/operations/setup-guide.md.
        </AlertBanner>
      )}
    </AuthCard>
  );
}
