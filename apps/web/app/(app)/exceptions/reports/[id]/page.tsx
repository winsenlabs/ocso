import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { ReportDetail } from '@/components/exceptions/report-detail';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import { Topbar } from '@/components/ui/topbar';
import '@/app/styles/system.css';
import '@/app/styles/approvals.css';
import '@/app/styles/exceptions.css';

export const metadata: Metadata = { title: 'Exception report' };

/** One exception report: sign it, download the signed export, read every check. */
export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      {/* The top bar reads the pathname, only known at request time on a dynamic route. */}
      <Suspense fallback={<Topbar searchLabel="Search" />}>
        <AppTopbar searchLabel="Search" />
      </Suspense>
      <PageHead
        title="Exception report"
        sub={
          <Link className="mono-sm" href="/exceptions?view=reports">
            All reports
          </Link>
        }
      />
      <PageBody>
        <ReportDetail params={params} />
      </PageBody>
    </>
  );
}
