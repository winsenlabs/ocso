import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Reviews' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Reviews"
      sub="Quality review of AI and human handling, conversation by conversation."
      requires={[Permission.REVIEWS_MANAGE]}
      emptyTitle="No reviews yet"
      searchLabel="Search reviews"
    >
      The review queue — sampled and flagged conversations with reviewer, outcome and score — will appear here once conversations are recorded.
    </PlaceholderPage>
  );
}
