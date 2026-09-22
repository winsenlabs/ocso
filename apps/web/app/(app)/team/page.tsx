import type { Metadata } from 'next';
import { AppTopbar } from '@/components/shell/app-topbar';
import { PageBody } from '@/components/shell/page-body';
import { TeamDirectory } from '@/components/team/team-directory';

export const metadata: Metadata = { title: 'Team' };

export default function TeamPage() {
  return (
    <>
      <AppTopbar searchLabel="Search people and teams" />
      <PageBody>
        <TeamDirectory />
      </PageBody>
    </>
  );
}
