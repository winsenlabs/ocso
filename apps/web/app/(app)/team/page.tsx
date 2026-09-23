import type { Metadata } from 'next';
import type { SearchParams } from '@/components/analytics/params';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { TeamDirectory } from '@/components/team/team-directory';
import '@/app/styles/team.css';

export const metadata: Metadata = { title: 'Team' };

export default function TeamPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <>
      <AppTopbar searchLabel="Search people and teams" />
      <PageBody>
        <TeamDirectory searchParams={searchParams} />
      </PageBody>
    </>
  );
}
