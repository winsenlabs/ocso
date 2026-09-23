import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { QueuesBody } from '@/components/system/queues-body';
import { SystemHead } from '@/components/system/system-head';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'Queues & leases' };

/** Work queue depth and age per topic, dead letters and conversation leases. */
export default function Page() {
  return (
    <>
      <AppTopbar searchLabel="Search workers, traces, connections" />
      <Suspense fallback={<PageHead title="Queues & leases" />}>
        <SystemHead title="Queues & leases" tail="queue depth, age and conversation ownership" />
      </Suspense>
      <PageBody>
        <QueuesBody />
      </PageBody>
    </>
  );
}
