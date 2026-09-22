import { ROLE_LABELS, type Role } from '@ocso/auth';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { Presence, type PresenceState } from '@/components/ui/presence';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import { teamNames, type Team } from '@/lib/api/teams';
import type { Availability, User } from '@/lib/api/users';
import { formatDateTime } from '@/lib/format';

const ROLE_TONE: Record<Role, StatusTone> = { PLATFORM_TECH_ADMIN: 'accent', CS_LEAD: 'good', CS_EXEC: 'muted' };
const AVAILABILITY: Record<Availability, { state: PresenceState; label: string }> = {
  AVAILABLE: { state: 'working', label: 'available' },
  AWAY: { state: 'waiting', label: 'away' },
  OFFLINE: { state: 'off_shift', label: 'offline' },
};

function columns(teams: Team[], timeZone: string): Column<User>[] {
  return [
    { key: 'name', header: 'Name', cell: (u) => <CellTitle title={u.name} caption={u.email} /> },
    { key: 'role', header: 'Role', cell: (u) => <StatusChip tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</StatusChip> },
    { key: 'teams', header: 'Teams', cell: (u) => <span className="mono-sm">{teamNames(teams, u.teamIds).join(', ') || '—'}</span> },
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
  ];
}

/** People in this deployment (GET /v1/users). */
export function UsersTable({ users, teams, timeZone }: { users: User[]; teams: Team[]; timeZone: string }) {
  return (
    <DataTable
      label="People"
      columns={columns(teams, timeZone)}
      rows={users}
      rowKey={(u) => u.id}
      template="minmax(0,1.4fr) 148px minmax(0,1fr) 108px 84px 116px"
      empty={<EmptyState title="No users yet">Create the first CS Lead or CS Exec account.</EmptyState>}
    />
  );
}
