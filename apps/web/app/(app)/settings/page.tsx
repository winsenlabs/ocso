import type { Metadata } from 'next';
import { GovernanceSection } from '@/components/settings/governance-section';
import { SettingsContent } from '@/components/settings/settings-content';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <AppTopbar searchLabel="Search settings" />
      <PageHead title="Settings" sub="Deployment identity and policy, data retention, Ask OCSO, and your account." />
      <PageBody>
        <SettingsContent />
        <GovernanceSection />
      </PageBody>
    </>
  );
}
