import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AgentsHead, AgentsList, PAGE_SUB, PAGE_TITLE } from '@/components/agents/list/agents-list';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';

export const metadata: Metadata = { title: 'Virtual agents' };

/** Virtual agents list (design/02 back-link target): every named AI employee with 7-day performance. */
export default function AgentsPage() {
  return (
    <>
      <AppTopbar searchLabel="Search agents, prompts, conversations" />
      <Suspense fallback={<PageHead title={PAGE_TITLE} sub={PAGE_SUB} />}>
        <AgentsHead />
      </Suspense>
      <PageBody>
        <AgentsList />
      </PageBody>
    </>
  );
}
