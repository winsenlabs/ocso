import type { Metadata } from 'next';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Search' };

export default function Page() {
  return (
    <PlaceholderPage title="Search" sub="Find customers, conversations, agents and configuration you are allowed to see." emptyTitle="Search is not available yet">
      Results across customers, conversations, virtual agents, connections and settings — filtered to what your role may see — will appear here once
      the search API is connected.
    </PlaceholderPage>
  );
}
