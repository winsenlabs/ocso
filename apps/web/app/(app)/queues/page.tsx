import type { Metadata } from 'next';
import { QueuesBody } from '@/components/queues/queues-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import '@/app/styles/ops.css';

export const metadata: Metadata = { title: 'Queues' };

/** Queues and routing (docs/09 §3); the title follows the role (leads manage, execs pick up). */
export default function Page() {
  return (
    <>
      <AppTopbar searchLabel="Search queues and conversations" />
      <PageBody>
        <QueuesBody />
      </PageBody>
    </>
  );
}
