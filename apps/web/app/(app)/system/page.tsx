import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { SystemHead } from '@/components/system/system-head';
import { SystemOverview } from '@/components/system/system-overview';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'System control center' };

const TITLE = 'System control center';

/** Platform Tech Admin control center (design/03). */
export default function SystemPage() {
  return (
    <>
      <AppTopbar searchLabel="Search workers, traces, connections">
        <span className="topbar-btn" title="Tiles cover the last hour; token and cost figures cover today">
          Last 1h
        </span>
      </AppTopbar>
      <Suspense fallback={<PageHead title={TITLE} />}>
        <SystemHead title={TITLE} tail="health, capacity and telemetry" />
      </Suspense>
      <PageBody>
        <SystemOverview />
      </PageBody>
    </>
  );
}
