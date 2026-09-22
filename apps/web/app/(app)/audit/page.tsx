import type { Metadata } from 'next';
import { AuditBody } from '@/components/audit/audit-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'Audit log' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Every privileged change and sensitive action, attributed to a person (docs/15 §7). */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search audit events" />
      <PageHead title="Audit log" sub="Every privileged change and sensitive action, attributed to a person — with what changed." />
      <PageBody>
        <AuditBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
