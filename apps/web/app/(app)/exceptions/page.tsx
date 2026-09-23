import type { Metadata } from 'next';
import { ExceptionsBody } from '@/components/exceptions/exceptions-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';
import '@/app/styles/approvals.css';
import '@/app/styles/exceptions.css';

export const metadata: Metadata = { title: 'Exceptions' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The exception report (PM/research/11 §7): what went around or wrong in the controls — live, and weekly to sign. */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search" />
      <PageHead title="Exceptions" sub="Everything that went around or wrong in the controls: live now, and frozen each week into a report a Head signs." />
      <PageBody>
        <ExceptionsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
