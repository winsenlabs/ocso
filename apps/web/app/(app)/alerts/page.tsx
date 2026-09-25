import type { Metadata } from 'next';
import { AlertsBody } from '@/components/alerts/alerts-body';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'Alerts' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Alerts addressed to the user's role, their rules and (Tech admin) delivery destinations (docs/archive/specs/11 §6–7). */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search alerts" />
      <PageHead title="Alerts" sub="Alerts addressed to your role, from open to acknowledged to resolved, and the rules that raise them." />
      <PageBody>
        <AlertsBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
