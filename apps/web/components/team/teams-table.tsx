import Link from 'next/link';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import type { Team } from '@/lib/api/teams';
import type { TeamScope } from './lib/membership';

function columns(scope: TeamScope): Column<Team>[] {
  const mine = new Set(scope.viewer.teamIds);
  const count = (list: ReadonlyArray<{ teamIds: readonly string[] }> | null, id: string) => (list ? list.filter((x) => x.teamIds.includes(id)).length : null);
  return [
    {
      key: 'team',
      header: 'Team',
      cell: (t) => (
        <CellTitle
          title={
            <Link href={`/team?team=${t.id}`} scroll={false}>
              {t.name}
            </Link>
          }
          caption={[mine.has(t.id) ? 'your team' : null, t.description].filter(Boolean).join(' · ') || undefined}
        />
      ),
    },
    { key: 'members', header: 'Members', cell: (t) => <span className="mono">{t.memberCount}</span> },
    {
      key: 'agents',
      header: 'Agents',
      // Other teams' agents are hidden from CS Leads (ADR-026): no count rather than a wrong one.
      cell: (t) => {
        const n = scope.allAgentsVisible || mine.has(t.id) ? count(scope.agents, t.id) : null;
        return <span className="mono" title={n === null ? 'Agents of teams you are not in are not visible to you' : undefined}>{n ?? '—'}</span>;
      },
    },
    { key: 'queues', header: 'Queues', cell: (t) => <span className="mono">{count(scope.queues, t.id) ?? '—'}</span> },
  ];
}

/** Teams own agents and serve queues (GET /v1/teams); a row opens the team drawer. */
export function TeamsTable({ teams, scope, selected }: { teams: Team[]; scope: TeamScope; selected: string | null }) {
  return (
    <DataTable
      label="Teams"
      columns={columns(scope)}
      rows={teams}
      rowKey={(t) => t.id}
      selectedKey={selected}
      template="minmax(0,1fr) 90px 90px 90px"
      empty={
        <EmptyState size="sm" title="No teams yet">
          Teams own virtual agents and serve queues. A CS Lead who creates a team joins it.
        </EmptyState>
      }
    />
  );
}
