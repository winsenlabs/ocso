import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Customers' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Customers"
      sub="Customer profiles and their identities across channels."
      requires={[Permission.CUSTOMERS_READ]}
      emptyTitle="No customers yet"
      searchLabel="Search customers"
    >
      Customer profiles — verified identities across WhatsApp, web, app, email and voice, with their conversation history and CSAT — will appear here once customers start contacting this deployment.
    </PlaceholderPage>
  );
}
