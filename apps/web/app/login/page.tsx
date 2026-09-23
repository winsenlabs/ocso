import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { LoginForm } from '@/components/auth/login-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import { fetchSetupStatus } from '@/lib/api/auth';
import { getSession } from '@/lib/session';
import { safeNextPath } from '@/lib/session-cookie';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Sign in' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Notices other flows hand over through the query string. */
const NOTICES: Record<string, { title: string; body: string; tone?: 'warn' | 'error' }> = {
  'setup=done': { title: 'Setup complete.', body: 'Sign in with the administrator account you just created.' },
  'reset=done': { title: 'Password changed.', body: 'Sign in with your new password. Your other sessions were signed out.' },
  'invite=accepted': { title: 'Welcome to OCSO.', body: 'Your password is set. Sign in to continue.' },
  'recovered=1': { title: 'Account recovered.', body: 'Sign in with the new password and set up two-factor authentication again if your role requires it.' },
  'sso=failed': { title: 'Single sign-on did not complete.', body: 'Your account may not be invited yet, or the identity provider refused. Ask your administrator.', tone: 'error' },
};

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
  const notice = Object.entries(NOTICES).find(([key]) => {
    const [name, value] = key.split('=');
    return first(params[name!]) === value;
  })?.[1];

  return (
    <AuthCard
      title="Sign in"
      sub={status ? `${status.orgName} · staff console` : 'Staff console'}
      foot={
        <>
          <span>single-tenant deployment</span>
          <span>·</span>
          <span>session in an httpOnly cookie</span>
          {status?.recovery ? (
            <>
              <span>·</span>
              <a className="auth-link" href="/recover">
                account recovery
              </a>
            </>
          ) : null}
        </>
      }
    >
      {notice ? (
        <AlertBanner tone={notice.tone ?? 'info'} title={notice.title} style={{ marginBottom: 14 }}>
          {notice.body}
        </AlertBanner>
      ) : null}
      {status === null ? (
        <AlertBanner tone="warn" title="The OCSO API is not reachable." style={{ marginBottom: 14 }}>
          Sign-in will fail until the API service is running.
        </AlertBanner>
      ) : null}
      <LoginForm next={next} sso={status?.sso ?? false} />
    </AuthCard>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
