import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Analytics' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Analytics"
      sub="Containment, escalation, resolution and satisfaction across agents and channels."
      requires={[Permission.ANALYTICS_BUSINESS_READ]}
      emptyTitle="No analytics yet"
      searchLabel="Search agents and metrics"
    >
      Business analytics — AI containment, human escalation, first response and resolution times, CSAT and SLA breaches by agent, channel and queue — will appear here once conversations are flowing.
    </PlaceholderPage>
  );
}
