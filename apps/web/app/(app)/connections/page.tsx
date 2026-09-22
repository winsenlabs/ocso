import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConnectionsBody } from '@/components/connections/connections-body';
import { ConnectionsHead, PAGE_SUB, PAGE_TITLE } from '@/components/connections/connections-head';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/connections.css';

export const metadata: Metadata = { title: 'Connections & models' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ConnectionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search providers, connections, secrets" />
      <Suspense fallback={<PageHead title={PAGE_TITLE} sub={PAGE_SUB} />}>
        <ConnectionsHead />
      </Suspense>
      <PageBody>
        <ConnectionsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
