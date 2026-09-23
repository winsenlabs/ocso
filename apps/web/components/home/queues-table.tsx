import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { HomeQueueRow } from '@/lib/api/home';
import { formatClock } from '@/lib/format';

const STATE: Record<HomeQueueRow['state'], StatusTone> = { ok: 'good', watch: 'warn', understaffed: 'danger' };

const COLUMNS: Column<HomeQueueRow>[] = [
  { key: 'queue', header: 'Queue', cell: (q) => q.name },
  { key: 'waiting', header: 'Waiting', cell: (q) => <span className="mono">{q.waiting}</span> },
  { key: 'shift', header: 'On shift', cell: (q) => <span className="mono">{`${q.onShift} / ${q.members}`}</span> },
  { key: 'wait', header: 'Avg wait', cell: (q) => <span className="mono">{q.avgWaitSeconds === null ? '—' : formatClock(q.avgWaitSeconds)}</span> },
  {
    key: 'breaches',
    header: 'Breaches',
    cell: (q) => (
      <span className="mono" title={`${q.breaches} waiting past SLA now · ${q.slaBreachesInWindow} this week`} style={q.state === 'understaffed' ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
        {q.slaBreachesInWindow}
      </span>
    ),
  },
  { key: 'state', header: 'State', cell: (q) => <StatusChip tone={STATE[q.state]}>{q.state}</StatusChip> },
];

/** Live queue health for the CS Lead (design/06 .dt-q): waiting, staff on shift, 7-day average wait and SLA breaches. */
export function QueuesTable({ rows }: { rows: HomeQueueRow[] }) {
  return (
    <DataTable
      label="Queues"
      columns={COLUMNS}
      rows={rows}
      rowKey={(q) => q.queueId}
      template="minmax(0,1fr) 72px 76px 84px 84px 100px"
      empty={<EmptyState title="No queues configured">Create queues to route escalations to your teams.</EmptyState>}
    />
  );
}
