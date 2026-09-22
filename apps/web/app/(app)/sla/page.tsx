import type { Metadata } from 'next';
import { SlaBody } from '@/components/queues/sla-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'SLA policies' };

export default function Page() {
  return (
    <>
      <AppTopbar searchLabel="Search SLA policies" />
      <PageHead title="SLA policies" sub="First-response and pickup targets per priority, resolution targets per conversation type — and which clocks are at risk or breached right now." />
      <PageBody>
        <SlaBody />
      </PageBody>
    </>
  );
}
