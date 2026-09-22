import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Audit log' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Audit log"
      sub="Every privileged change and sensitive action, attributed to a person."
      requires={[Permission.AUDIT_READ]}
      emptyTitle="No audit feed yet"
      searchLabel="Search audit events"
    >
      The audit log — configuration changes, role changes, sensitive tool confirmations and internal-agent actions, each with actor, target, before/after and correlation ID — will appear here once the audit API is connected.
    </PlaceholderPage>
  );
}
