import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { SetPasswordForm } from '@/components/auth/set-password-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import { fetchSetupStatus } from '@/lib/api/auth';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Accept invite' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Invite landing page: the invited user chooses their password (Better Auth /reset-password). */
export default function InvitePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <InviteContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function InviteContent({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams)['token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const status = await fetchSetupStatus().catch(() => null);
  return (
    <AuthCard
      title="Accept your invite"
      sub={`${status?.orgName ?? 'OCSO'} · choose the password you will sign in with.`}
      foot={
        status?.sso ? <span>your organization also offers single sign-on on the sign-in page</span> : <span>the invite link works once</span>
      }
    >
      {token ? (
        <SetPasswordForm token={token} purpose="invite" />
      ) : (
        <AlertBanner tone="error" title="This invite link is incomplete.">
          Open the link from the invite email again, or ask the person who invited you to send a new one.
        </AlertBanner>
      )}
    </AuthCard>
  );
}
