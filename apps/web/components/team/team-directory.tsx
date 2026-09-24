import { Permission, ROLES, ROLE_LABELS, ROLE_PERMISSIONS } from '@ocso/auth';
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
import { UserDrawer, loadUserApproval, loadUserDrawer, type UserDrawerTab } from './user-drawer';
import { listUserChatLinks } from '@/lib/api/chat-links';
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
 * People and teams (GET /v1/users, GET /v1/teams). users.manage creates any
 * preset and manages every membership; users.manage_team creates colleagues
 * whose rights fit inside the viewer's own, on the viewer's teams. The API
 * enforces both. `?team=<id>` opens the team drawer, `?user=<id>` the user
 * drawer (`&tab=permissions` its Permissions tab).
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
  const selectedUser = selected ? null : (idParam(params, 'user') ?? null);
  const userTab: UserDrawerTab = params['tab'] === 'permissions' ? 'permissions' : 'overview';
  const canReadPermissions = hasPermission(session, Permission.PERMISSIONS_READ);
  const canChangePermissions = hasPermission(session, Permission.PERMISSIONS_MANAGE);
  const [users, teams, agents, queues, detail, drawerData, drawerApproval] = await Promise.all([
    listUsers(),
    listTeams(),
    orNull(listTeamBoundAgents()),
    orNull(listTeamBoundQueues()),
    selected ? loadTeamDetail(selected) : Promise.resolve(null),
    selectedUser && userTab === 'permissions' ? loadUserDrawer(selectedUser, canReadPermissions, canChangePermissions) : Promise.resolve({ permissions: null, catalogue: [] }),
    // Maker–checker (PM/research/11 §3.4): the proposal waiting on this person, for the drawer's badge.
    selectedUser ? loadUserApproval(selectedUser) : Promise.resolve(null),
  ]);
  // Ask OCSO chat account links (Slack, Teams): a Tech admin with users.manage sees and revokes them on the overview.
  const chatLinks = selectedUser && userTab === 'overview' && manageAll ? await listUserChatLinks(selectedUser).catch(() => null) : null;
  const userData = { ...drawerData, approval: drawerApproval, chatLinks };
  // Containment (PM/research/11 §3.4): without users.manage, presets whose rights fit inside the viewer's own.
  const creatable = manageAll
    ? ROLES
    : hasPermission(session, Permission.USERS_MANAGE_TEAM)
      ? ROLES.filter((r) => [...ROLE_PERMISSIONS[r]].every((p) => session.permissions.has(p)))
      : [];
  const drawerUser = selectedUser ? (users.find((u) => u.id === selectedUser) ?? null) : null;
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
        sub={manageAll ? 'Everyone with access to this deployment, their role and teams.' : 'Your teams and the Service members you manage.'}
        actions={
          <TeamActions
            canCreateTeam={hasPermission(session, Permission.TEAMS_MANAGE)}
            roles={creatable.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
            // POST /v1/users does not check a lead's teams yet: offer leads only the teams they belong to.
            teams={teams.filter((t) => manageAll || session.user.teamIds.includes(t.id)).map((t) => ({ value: t.id, label: t.name }))}
          />
        }
      />
      <SecHead
        title="People"
        count={users.length}
        desc="new users and access increases wait for a checker's approval · reductions apply at once and end sessions on a preset change"
      />
      <UsersTable users={users} timeZone={timeZone} viewer={{ id: session.user.id, manageable: creatable }} selected={selectedUser} />
      <SecHead
        title="Teams"
        count={teams.length}
        desc="teams own virtual agents and serve queues · a Lead manages the agents of the teams they belong to"
        style={{ marginTop: 22 }}
      />
      <TeamsTable teams={teams} scope={scope} selected={selected} />
      {selected ? <TeamDrawer team={detail} scope={scope} timeZone={timeZone} /> : null}
      {selectedUser ? (
        <UserDrawer
          user={drawerUser}
          tab={userTab}
          data={userData}
          teamNames={drawerUser ? teams.filter((t) => drawerUser.teamIds.includes(t.id)).map((t) => t.name) : []}
          timeZone={timeZone}
          viewer={{ id: session.user.id, canReadPermissions, canChangePermissions, canManageUsers: hasPermission(session, Permission.USERS_MANAGE) || hasPermission(session, Permission.USERS_MANAGE_TEAM) }}
        />
      ) : null}
    </TeamScopeProvider>
  );
}
