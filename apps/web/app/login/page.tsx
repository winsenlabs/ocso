import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import { fetchSetupStatus } from '@/lib/api/auth';
import { getSession } from '@/lib/session';
import { safeNextPath } from '@/lib/session-cookie';

export const metadata: Metadata = { title: 'Sign in' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <LoginContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function LoginContent({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const next = safeNextPath(first(params['next']));
  const [session, status] = await Promise.all([getSession().catch(() => null), fetchSetupStatus().catch(() => null)]);
  if (session) redirect(next);
  if (status?.setupRequired) redirect('/setup');

  return (
    <AuthCard
      title="Sign in"
      sub={status ? `${status.orgName} · staff console` : 'Staff console'}
      foot={
        <>
          <span>single-tenant deployment</span>
          <span>·</span>
          <span>session in an httpOnly cookie</span>
        </>
      }
    >
      {first(params['setup']) === 'done' ? (
        <AlertBanner title="Setup complete." style={{ marginBottom: 14 }}>
          Sign in with the administrator account you just created.
        </AlertBanner>
      ) : null}
      {status === null ? (
        <AlertBanner tone="warn" title="The OCSO API is not reachable." style={{ marginBottom: 14 }}>
          Sign-in will fail until the API service is running.
        </AlertBanner>
      ) : null}
      <LoginForm next={next} />
    </AuthCard>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
