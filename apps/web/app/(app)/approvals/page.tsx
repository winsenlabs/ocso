import type { Metadata } from 'next';
import { ApprovalsBody } from '@/components/approvals/approvals-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';
import '@/app/styles/approvals.css';

export const metadata: Metadata = { title: 'Approvals' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Maker–checker queue (PM/research/11 §4): changes awaiting me, sent by me, all open (Tech) and decided. */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search approvals" />
      <PageHead title="Approvals" sub="Every change to live configuration waits here for a named checker. Nothing changes until they approve." />
      <PageBody>
        <ApprovalsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
