import { Permission, ROLES, ROLE_LABELS } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { PageHead } from '@/components/ui/page-head';
import { SecHead } from '@/components/ui/sec-head';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { hasPermission, requireSession } from '@/lib/session';
import { TeamActions } from './team-actions';
import { TeamsTable } from './teams-table';
import { UsersTable } from './users-table';

/**
 * People and teams (GET /v1/users, GET /v1/teams). Tech Admins create any
 * role; CS Leads are offered CS Exec only (the API enforces the same rule).
 */
export async function TeamDirectory() {
  const session = await requireSession();
  const manageAll = hasPermission(session, Permission.USERS_MANAGE);
  const title = manageAll ? 'Team & roles' : 'Team';
  if (!hasPermission(session, Permission.USERS_READ)) {
    return (
      <>
        <PageHead title={title} />
        <NotPermitted role={session.roleLabel} />
      </>
    );
  }

  const [users, teams] = await Promise.all([listUsers(), listTeams()]);
  const creatable = manageAll ? ROLES : hasPermission(session, Permission.USERS_MANAGE_EXECS) ? (['CS_EXEC'] as const) : [];

  return (
    <>
      <PageHead
        title={title}
        sub={manageAll ? 'Everyone with access to this deployment, their role and teams.' : 'Your teams and the CS Execs you manage.'}
        actions={
          <TeamActions
            canCreateTeam={hasPermission(session, Permission.TEAMS_MANAGE)}
            roles={creatable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            teams={teams.map((t) => ({ value: t.id, label: t.name }))}
          />
        }
      />
      <SecHead title="People" count={users.length} desc="role changes and deactivation end the user's sessions immediately" />
      <UsersTable users={users} teams={teams} timeZone={session.user.deployment.timezone} />
      <SecHead title="Teams" count={teams.length} style={{ marginTop: 22 }} />
      <TeamsTable teams={teams} />
    </>
  );
}
