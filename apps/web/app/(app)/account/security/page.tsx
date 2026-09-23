import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AccountSecurity } from '@/components/account/account-security';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '../../../styles/auth.css';

export const metadata: Metadata = { title: 'Account security' };

export default function AccountSecurityPage() {
  return (
    <>
      <AppTopbar searchLabel="Search" />
      <PageHead title="Account security" sub="Your password, two-factor authentication, passkeys and signed-in sessions." />
      <PageBody>
        <Suspense fallback={<div className="shell-skeleton" aria-busy="true" />}>
          <AccountSecurity />
        </Suspense>
      </PageBody>
    </>
  );
}
