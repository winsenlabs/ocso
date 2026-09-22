import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Telemetry' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Telemetry"
      sub="Latency, tokens, cache and provider error rates across the runtime."
      requires={[Permission.TELEMETRY_TECHNICAL_READ]}
      emptyTitle="No telemetry yet"
      searchLabel="Search workers, traces, connections"
    >
      Turn latency and time to first token, request rate, input/output tokens, prompt-cache reads and writes, provider error rates and traces will appear here once the runtime exports telemetry to the API.
    </PlaceholderPage>
  );
}
