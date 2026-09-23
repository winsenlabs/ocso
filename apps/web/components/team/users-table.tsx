import { ROLE_LABELS, type Role } from '@ocso/auth';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Presence } from '@/components/ui/presence';
import { StatusChip } from '@/components/ui/status-chip';
import type { User } from '@/lib/api/users';
import { formatDateTime } from '@/lib/format';
import { AVAILABILITY, ROLE_TONE } from './labels';
import { UserAccess } from './user-access';
import { UserTeams } from './user-teams';

/** Who the viewer may manage (Tech admin: every role; Lead: Service members), and who they are. */
export interface Viewer {
  id: string;
  manageable: readonly Role[];
}

function columns(timeZone: string, viewer: Viewer): Column<User>[] {
  return [
    { key: 'name', header: 'Name', cell: (u) => <CellTitle title={u.name} caption={u.email} /> },
    { key: 'role', header: 'Role', cell: (u) => <StatusChip tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</StatusChip> },
    { key: 'teams', header: 'Teams', cell: (u) => <UserTeams person={{ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, teamIds: u.teamIds }} /> },
    {
      key: 'availability',
      header: 'Availability',
      cell: (u) => <Presence state={AVAILABILITY[u.availability].state}>{AVAILABILITY[u.availability].label}</Presence>,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => <StatusChip tone={u.status === 'ACTIVE' ? 'good' : 'muted'}>{u.status === 'ACTIVE' ? 'active' : 'disabled'}</StatusChip>,
    },
    { key: 'login', header: 'Last sign-in', cell: (u) => <span className="mono-sm">{u.lastLoginAt ? formatDateTime(u.lastLoginAt, timeZone) : 'never'}</span> },
    {
      key: 'access',
      header: 'Sign-in',
      cell: (u) => (
        <UserAccess
          userId={u.id}
          name={u.name}
          invite={u.invite.status}
          mfaEnabled={u.mfaEnabled}
          active={u.status === 'ACTIVE'}
          canManage={viewer.manageable.includes(u.role)}
          isSelf={u.id === viewer.id}
        />
      ),
    },
  ];
}

/** People in this deployment (GET /v1/users); team chips open the team drawer, "Edit" changes memberships. */
export function UsersTable({ users, timeZone, viewer }: { users: User[]; timeZone: string; viewer: Viewer }) {
  return (
    <DataTable
      label="People"
      columns={columns(timeZone, viewer)}
      rows={users}
      rowKey={(u) => u.id}
      template="minmax(0,1.2fr) 130px minmax(0,1.2fr) 100px 80px 112px minmax(150px,0.9fr)"
      empty={<EmptyState title="No users yet">Invite the first Lead or Service member.</EmptyState>}
    />
  );
}
