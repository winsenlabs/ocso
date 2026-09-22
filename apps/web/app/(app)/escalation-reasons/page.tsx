import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Escalation reasons' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Escalation reasons"
      sub="Why virtual agents hand conversations to humans, ranked and trended."
      requires={[Permission.ANALYTICS_BUSINESS_READ]}
      emptyTitle="No escalation data yet"
      searchLabel="Search escalation reasons"
    >
      Handoff reasons — above authority, hardship language, disputes, tool failures, customer asked for a human — with volume, trend and the queue they route to will appear here once conversations are escalating.
    </PlaceholderPage>
  );
}
