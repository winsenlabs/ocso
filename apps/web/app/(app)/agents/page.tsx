import type { Metadata } from 'next';
import { Permission } from '@ocso/auth';
import { PlaceholderPage } from '@/components/shell/placeholder-page';

export const metadata: Metadata = { title: 'Virtual agents' };

export default function Page() {
  return (
    <PlaceholderPage
      title="Virtual agents"
      sub="Named AI employees: their prompts, tools, channels and performance."
      requires={[Permission.AGENTS_READ]}
      emptyTitle="No virtual agents yet"
      searchLabel="Search agents, prompts, conversations"
    >
      Each virtual agent — its prompt version, model profile, channels, tools and operating metrics — will appear here once the agents API is connected.
    </PlaceholderPage>
  );
}
