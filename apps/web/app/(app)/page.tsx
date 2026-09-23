import type { Metadata } from 'next';
import { HomeContent } from '@/components/home/home-content';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';

export const metadata: Metadata = { title: 'Home' };

/** Role-aware home (design/06). */
export default function HomePage() {
  return (
    <>
      <AppTopbar searchLabel="Search customers, conversations, agents" />
      <PageBody>
        <HomeContent />
      </PageBody>
    </>
  );
}
