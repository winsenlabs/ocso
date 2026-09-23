import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { SetupForm } from '@/components/auth/setup-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import { fetchSetupStatus } from '@/lib/api/auth';

export const metadata: Metadata = { title: 'First-run setup' };

export default function SetupPage() {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <SetupContent />
      </Suspense>
    </main>
  );
}

async function SetupContent() {
  const status = await fetchSetupStatus().catch(() => null);
  if (status && !status.setupRequired) redirect('/login');

  return (
    <AuthCard
      wide
      title="Set up OCSO"
      sub="Create the first Platform Tech Admin for this deployment. This page is available only until the first user exists."
      foot={
        <>
          <span>one deployment = one organization</span>
          <span>·</span>
          <span>more users are added from Team</span>
        </>
      }
    >
      {status === null ? (
        <AlertBanner tone="warn" title="The OCSO API is not reachable." style={{ marginBottom: 14 }}>
          Start the API service, then reload this page.
        </AlertBanner>
      ) : null}
      <SetupForm timezones={supportedTimezones()} />
    </AuthCard>
  );
}

function supportedTimezones(): string[] {
  const zones = Intl.supportedValuesOf('timeZone');
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}
