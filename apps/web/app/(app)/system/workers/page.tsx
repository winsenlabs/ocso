import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';
import { WorkerConfigSection } from '@/components/system/worker-config-section';

export const metadata: Metadata = { title: 'Workers' };

export default function WorkersPage() {
  return (
    <PlaceholderPage
      title="Workers"
      sub="Agent worker capacity: the scaling configuration and the running instances."
      requires={[Permission.SYSTEM_READ]}
      emptyTitle="No worker instances reported yet"
      searchLabel="Search workers, traces, connections"
      before={<WorkerConfigSection />}
    >
      Each worker instance — status, conversations held, utilisation, memory and CPU, start time and heartbeat — plus active conversation leases will
      appear here once workers report their heartbeats to the API.
    </PlaceholderPage>
  );
}
