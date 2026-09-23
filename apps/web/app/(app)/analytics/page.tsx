import type { Metadata } from 'next';
import { AnalyticsBody } from '@/components/analytics/analytics-body';
import type { SearchParams } from '@/components/analytics/params';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Analytics' };

/** Lead business analytics (docs/11 §3, design/02 Overview + Analytics patterns). */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search agents and metrics" />
      <PageHead title="Analytics" sub="Containment, escalation, resolution and satisfaction across virtual agents, channels and queues. Every number links to its formula." />
      <PageBody>
        <AnalyticsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
