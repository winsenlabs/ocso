import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Queues' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Queues"
      sub="Waiting conversations per queue, their SLA clocks, and who is on shift."
      requires={[Permission.QUEUES_READ]}
      emptyTitle="No queue data yet"
      searchLabel="Search queues and conversations"
    >
      Queues with conversations waiting for a human — open pickup or auto-assign, oldest first, with SLA timers and a claim action — will appear here once routing is live.
    </PlaceholderPage>
  );
}
