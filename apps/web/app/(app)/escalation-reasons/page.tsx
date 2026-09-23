import type { Metadata } from 'next';
import { EscalationReasonsBody } from '@/components/analytics/escalation-reasons-body';
import type { SearchParams } from '@/components/analytics/params';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Escalation reasons' };

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search escalation reasons" />
      <PageHead title="Escalation reasons" sub="Why virtual agents hand conversations to humans — ranked, compared with the previous window, and trended per day." />
      <PageBody>
        <EscalationReasonsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
