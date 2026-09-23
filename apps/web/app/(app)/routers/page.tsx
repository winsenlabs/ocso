import type { Metadata } from 'next';
import { RoutersBody } from '@/components/routers/routers-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import '@/app/styles/ops.css';
import '@/app/styles/routers.css';

export const metadata: Metadata = { title: 'Routers' };

/** Routers (PM/research/11 §5.7): channel → router → queue → agent. */
export default function Page() {
  return (
    <>
      <AppTopbar searchLabel="Search routers and conversations" />
      <PageBody>
        <RoutersBody />
      </PageBody>
    </>
  );
}
