import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { AgentDetail } from '@/components/agents/detail/agent-detail';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { Topbar } from '@/components/ui/topbar';

export const metadata: Metadata = { title: 'Virtual agent' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const SEARCH = 'Search agents, prompts, conversations';

/** One virtual agent: overview, prompt, tools, channels, routing, escalation, analytics, versions, quality, settings. */
export default function AgentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SearchParams }) {
  return (
    <>
      {/* The top bar reads the pathname (Ask OCSO context), which is only known at request time on a dynamic route. */}
      <Suspense fallback={<Topbar searchLabel={SEARCH} />}>
        <AppTopbar searchLabel={SEARCH} />
      </Suspense>
      <Link className="back" href="/agents">
        ← Virtual agents
      </Link>
      <PageBody>
        <AgentDetail params={params} searchParams={searchParams} />
      </PageBody>
    </>
  );
}
