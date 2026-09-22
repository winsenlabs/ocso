import { Permission, ROLES, ROLE_LABELS } from '@ocso/auth';
import { idParam, type SearchParams } from '@/components/analytics/params';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { PageHead } from '@/components/ui/page-head';
import { SecHead } from '@/components/ui/sec-head';
import { ApiError } from '@/lib/api/errors';
import { listTeamBoundAgents, listTeamBoundQueues, listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { hasPermission, requireSession, type Session } from '@/lib/session';
import type { TeamScope } from './lib/membership';
import { TeamScopeProvider } from './scope-context';
import { TeamActions } from './team-actions';
import { TeamDrawer, loadTeamDetail } from './team-drawer';
import { TeamsTable } from './teams-table';
import { UsersTable } from './users-table';

/** A read the role may not have (403) degrades to null: the views then say what they cannot show. */
async function orNull<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError && (err.isForbidden || err.status === 404)) return null;
    throw err;
  }
}

function viewerOf(session: Session): TeamScope['viewer'] {
  return {
    id: session.user.id,
    manageAll: hasPermission(session, Permission.USERS_MANAGE),
    manageTeams: hasPermission(session, Permission.TEAMS_MANAGE),
    teamIds: session.user.teamIds,
  };
}

/**
 * People and teams (GET /v1/users, GET /v1/teams). Tech Admins create any
 * role and manage every membership; CS Leads create CS Execs and manage CS
 * Exec memberships (and their own) on their teams. The API enforces both.
 * `?team=<id>` opens the team drawer.
 */
export async function TeamDirectory({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
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

  const selected = idParam(params, 'team') ?? null;
  const [users, teams, agents, queues, detail] = await Promise.all([
    listUsers(),
    listTeams(),
    orNull(listTeamBoundAgents()),
    orNull(listTeamBoundQueues()),
    selected ? loadTeamDetail(selected) : Promise.resolve(null),
  ]);
  const creatable = manageAll ? ROLES : hasPermission(session, Permission.USERS_MANAGE_EXECS) ? (['CS_EXEC'] as const) : [];
  const scope: TeamScope = {
    viewer: viewerOf(session),
    people: users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, teamIds: u.teamIds })),
    teams: teams.map((t) => ({ id: t.id, name: t.name })),
    agents,
    queues,
    allAgentsVisible: hasPermission(session, Permission.AGENTS_READ_ALL),
  };
  const timeZone = session.user.deployment.timezone;

  return (
    <TeamScopeProvider scope={scope}>
      <PageHead
        title={title}
        sub={manageAll ? 'Everyone with access to this deployment, their role and teams.' : 'Your teams and the CS Execs you manage.'}
        actions={
          <TeamActions
            canCreateTeam={hasPermission(session, Permission.TEAMS_MANAGE)}
            roles={creatable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            // POST /v1/users does not check a lead's teams yet: offer leads only the teams they belong to.
            teams={teams.filter((t) => manageAll || session.user.teamIds.includes(t.id)).map((t) => ({ value: t.id, label: t.name }))}
          />
        }
      />
      <SecHead title="People" count={users.length} desc="invited users choose their own password · role changes and deactivation end their sessions immediately" />
      <UsersTable users={users} timeZone={timeZone} viewer={{ id: session.user.id, manageable: creatable }} />
      <SecHead
        title="Teams"
        count={teams.length}
        desc="teams own virtual agents and serve queues · a CS Lead manages the agents of the teams they belong to"
        style={{ marginTop: 22 }}
      />
      <TeamsTable teams={teams} scope={scope} selected={selected} />
      {selected ? <TeamDrawer team={detail} scope={scope} timeZone={timeZone} /> : null}
    </TeamScopeProvider>
  );
}
