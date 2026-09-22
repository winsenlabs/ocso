import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Queues & leases' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Queues & leases"
      sub="Work queue depth and age, and which worker holds each conversation lease."
      requires={[Permission.SYSTEM_READ]}
      emptyTitle="No queue telemetry yet"
      searchLabel="Search workers, traces, connections"
    >
      Queue depth and oldest-item age, active conversation leases, heartbeats and recovered leases will appear here once workers report to the API.
    </PlaceholderPage>
  );
}
