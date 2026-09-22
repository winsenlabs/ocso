import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Conversations' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Conversations"
      sub="Every conversation you are allowed to see, with who is in control of each."
      requires={[Permission.CONVERSATIONS_READ]}
      emptyTitle="No conversations yet"
      searchLabel="Search customer, number, or ticket"
    >
      The inbox, full interaction timeline, customer context rail and composer will appear here once the conversations API is connected — AI-active, waiting-for-human, assigned and recently resolved conversations, filtered to what your role may see.
    </PlaceholderPage>
  );
}
