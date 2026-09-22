import type { Metadata } from 'next';
import type { SearchParams } from '@/components/analytics/params';
import { CorrectionsBody } from '@/components/quality/corrections-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Prompt corrections' };

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search corrections" />
      <PageBody>
        <CorrectionsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
