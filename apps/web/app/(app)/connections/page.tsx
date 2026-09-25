import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ConnectionsBody } from '@/components/connections/connections-body';
import { ConnectionsHead, PAGE_TITLE } from '@/components/connections/connections-head';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/connections.css';

export const metadata: Metadata = { title: PAGE_TITLE };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Integrations: Models, MCP connections, Channels, Secrets and Webhooks, one
 * section per sidebar entry (`?tab=`). The old `?tab=mine` is redirected to
 * `?tab=mcp&view=mine` by proxy.ts.
 */
export default function ConnectionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search providers, connections, secrets" />
      <Suspense fallback={<PageHead title={PAGE_TITLE} />}>
        <ConnectionsHead searchParams={searchParams} />
      </Suspense>
      <PageBody>
        <ConnectionsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
