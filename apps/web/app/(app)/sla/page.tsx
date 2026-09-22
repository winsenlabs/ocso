import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'SLA policies' };

export default function Page() {
  return (
    <PlaceholderPage
      title="SLA policies"
      sub="Response and resolution targets per queue and priority."
      requires={[Permission.SLA_MANAGE]}
      emptyTitle="No SLA policies yet"
      searchLabel="Search SLA policies"
    >
      SLA policies — first human response, pickup and resolution targets by queue and priority, with attainment — will appear here once the SLA API is connected.
    </PlaceholderPage>
  );
}
