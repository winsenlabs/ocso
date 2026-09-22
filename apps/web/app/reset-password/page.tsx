import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCard, AuthCardSkeleton } from '@/components/auth/auth-card';
import { SetPasswordForm } from '@/components/auth/set-password-form';
import { AlertBanner } from '@/components/ui/alert-banner';
import '../styles/auth.css';

export const metadata: Metadata = { title: 'Choose a new password' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ResetPasswordPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="auth-wrap">
      <div className="grid-bg" aria-hidden="true" />
      <Suspense fallback={<AuthCardSkeleton />}>
        <ResetContent searchParams={searchParams} />
      </Suspense>
    </main>
  );
}

async function ResetContent({ searchParams }: { searchParams: SearchParams }) {
  const raw = (await searchParams)['token'];
  const token = Array.isArray(raw) ? raw[0] : raw;
  return (
    <AuthCard title="Choose a new password" sub="The link works once. Afterwards every session of your account is signed out." foot={<a className="auth-link" href="/login">back to sign-in</a>}>
      {token ? (
        <SetPasswordForm token={token} purpose="reset" />
      ) : (
        <AlertBanner tone="error" title="This link is incomplete.">
          Open the link from the email again, or ask for a new one on the sign-in page.
        </AlertBanner>
      )}
    </AuthCard>
  );
}
