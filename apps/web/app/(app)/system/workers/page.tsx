import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { SystemHead } from '@/components/system/system-head';
import { WorkersBody } from '@/components/system/workers-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'Workers' };

/** Agent worker capacity: the fleet, how the platform applied the scaling settings, and the settings themselves. */
export default function WorkersPage() {
  return (
    <>
      <AppTopbar searchLabel="Search workers, traces, connections" />
      <Suspense fallback={<PageHead title="Workers" />}>
        <SystemHead title="Workers" tail="fleet and scaling" />
      </Suspense>
      <PageBody>
        <WorkersBody />
      </PageBody>
    </>
  );
}
