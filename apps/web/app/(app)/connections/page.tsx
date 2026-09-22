import type { Metadata } from 'next';
import { ConnectionsBody } from '@/components/connections/connections-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';

export const metadata: Metadata = { title: 'Connections & models' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function ConnectionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search providers, connections, secrets" />
      <PageHead title="Connections & models" sub="Everything OCSO talks to. Credentials are stored by reference; the model never receives them." />
      <PageBody>
        <ConnectionsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
