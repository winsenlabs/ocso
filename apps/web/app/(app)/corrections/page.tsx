import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Prompt corrections' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Prompt corrections"
      sub="Behaviour fixes captured from real conversations, staged into new prompt versions."
      requires={[Permission.CORRECTIONS_MANAGE]}
      emptyTitle="No corrections staged"
      searchLabel="Search corrections"
    >
      Corrections — source conversation and turn, observed problem, desired behaviour, the prompt component changed and the version it lands in — will appear here once prompt versioning is connected.
    </PlaceholderPage>
  );
}
