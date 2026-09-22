import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Alerts' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Alerts"
      sub="Alerts addressed to your role, from open to acknowledged to resolved."
      requires={[Permission.ALERTS_BUSINESS_READ, Permission.ALERTS_TECHNICAL_READ]}
      emptyTitle="No alerts yet"
      searchLabel="Search alerts"
    >
      Alerts for your audience — rule, severity, source, age and lifecycle (open, acknowledged, resolved), correlated to the conversations or telemetry that fired them — will appear here once alert rules are evaluated by the API.
    </PlaceholderPage>
  );
}
