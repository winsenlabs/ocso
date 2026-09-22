import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';
import { DeploymentCard } from '@/components/system/deployment-card';

export const metadata: Metadata = { title: 'System control center' };

export default function SystemPage() {
  return (
    <PlaceholderPage
      title="System control center"
      sub="Service health, capacity and telemetry for this single-tenant deployment."
      requires={[Permission.SYSTEM_READ]}
      emptyTitle="No service telemetry yet"
      searchLabel="Search workers, traces, connections"
      before={<DeploymentCard />}
    >
      Service status (API, agent runtime, PostgreSQL, queue, providers, MCP, channels, webhooks), latency and token telemetry, and provider and MCP
      health will appear here once the runtime reports to the API. Worker configuration is already available under Workers.
    </PlaceholderPage>
  );
}
