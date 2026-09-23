import type { Metadata } from 'next';
import Link from 'next/link';
import { Suspense } from 'react';
import { RouterDetailBody } from '@/components/routers/router-detail';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { Topbar } from '@/components/ui/topbar';
import '@/app/styles/ops.css';
import '@/app/styles/routers.css';

export const metadata: Metadata = { title: 'Router' };

const SEARCH = 'Search routers and conversations';

async function Body({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RouterDetailBody id={id} />;
}

/** One router: the draft builder, versions and activation through approval, channels, simulator (PM/research/11 §5.7). */
export default function RouterPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <Suspense fallback={<Topbar searchLabel={SEARCH} />}>
        <AppTopbar searchLabel={SEARCH} />
      </Suspense>
      <Link className="back" href="/routers">
        ← Routers
      </Link>
      <PageBody>
        <Suspense fallback={<p className="mono-sm">Loading router…</p>}>
          <Body params={params} />
        </Suspense>
      </PageBody>
    </>
  );
}
