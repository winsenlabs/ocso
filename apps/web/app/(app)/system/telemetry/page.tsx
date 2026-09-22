import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { SystemHead } from '@/components/system/system-head';
import { TelemetryBody } from '@/components/system/telemetry-body';
import { PageHead } from '@/components/ui/page-head';
import '@/app/styles/system.css';

export const metadata: Metadata = { title: 'Telemetry' };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Latency, tokens, prompt cache and provider error rates across the runtime. */
export default function Page({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search workers, traces, connections" />
      <Suspense fallback={<PageHead title="Telemetry" />}>
        <SystemHead title="Telemetry" tail="latency, tokens and prompt cache" />
      </Suspense>
      <PageBody>
        <TelemetryBody searchParams={searchParams} />
      </PageBody>
    </>
  );
}
