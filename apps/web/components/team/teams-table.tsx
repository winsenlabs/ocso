import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import type { Team } from '@/lib/api/teams';

const COLUMNS: Column<Team>[] = [
  { key: 'team', header: 'Team', cell: (t) => <CellTitle title={t.name} caption={t.description ?? undefined} /> },
  { key: 'members', header: 'Members', cell: (t) => <span className="mono">{t.memberCount}</span> },
];

/** Teams drive queue and conversation visibility (GET /v1/teams). */
export function TeamsTable({ teams }: { teams: Team[] }) {
  return (
    <DataTable
      label="Teams"
      columns={COLUMNS}
      rows={teams}
      rowKey={(t) => t.id}
      template="minmax(0,1fr) 90px"
      empty={
        <EmptyState size="sm" title="No teams yet">
          Teams group CS Execs for routing and visibility.
        </EmptyState>
      }
    />
  );
}
