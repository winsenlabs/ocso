import type { Metadata } from 'next';
import { EmailSection } from '@/components/settings/email-section';
import { GovernanceSection } from '@/components/settings/governance-section';
import { SecuritySection } from '@/components/settings/security-section';
import { SettingsContent } from '@/components/settings/settings-content';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '../../styles/auth.css';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <AppTopbar searchLabel="Search settings" />
      <PageHead title="Settings" sub="Deployment identity and policy, data retention, Ask OCSO, and your account." />
      <PageBody>
        <SettingsContent />
        <GovernanceSection />
        <EmailSection />
        <SecuritySection />
      </PageBody>
    </>
  );
}
