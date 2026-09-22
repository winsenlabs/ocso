import { DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { QueueSummary } from '@/lib/api/queues';
import { formatClock } from '@/lib/format';

const STATE: Record<QueueSummary['state'], StatusTone> = { ok: 'good', watch: 'warn', understaffed: 'danger' };

const COLUMNS: Column<QueueSummary>[] = [
  { key: 'queue', header: 'Queue', cell: (q) => q.name },
  { key: 'waiting', header: 'Waiting', cell: (q) => <span className="mono">{q.waiting}</span> },
  { key: 'shift', header: 'On shift', cell: (q) => <span className="mono">{`${q.onShift} / ${q.capacity}`}</span> },
  { key: 'wait', header: 'Avg wait', cell: (q) => <span className="mono">{formatClock(q.avgWaitSeconds)}</span> },
  {
    key: 'breaches',
    header: 'Breaches',
    cell: (q) => (
      <span className="mono" style={q.state === 'understaffed' ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
        {q.breaches}
      </span>
    ),
  },
  { key: 'state', header: 'State', cell: (q) => <StatusChip tone={STATE[q.state]}>{q.state}</StatusChip> },
];

/** Live queue health for the CS Lead (design/06 .dt-q). */
export function QueuesTable({ rows }: { rows: QueueSummary[] | null }) {
  if (rows === null) {
    return (
      <EmptyState title="No queue data yet">
        Each queue&apos;s waiting count, execs on shift, average wait and SLA breaches will appear here once routing is live.
      </EmptyState>
    );
  }
  return (
    <DataTable
      label="Queues"
      columns={COLUMNS}
      rows={rows}
      rowKey={(q) => q.id}
      template="minmax(0,1fr) 72px 76px 84px 84px 80px"
      empty={<EmptyState title="No queues configured">Create queues from Queues to route escalations to your teams.</EmptyState>}
    />
  );
}
