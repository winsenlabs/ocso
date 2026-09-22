import Link from 'next/link';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { QueueAnalytics, QueueAnalyticsRow } from '@/lib/api/analytics';
import { formatAge, formatDuration, formatNumber } from '@/lib/format';
import { Th } from './parts';

const STATE: Record<QueueAnalyticsRow['state'], StatusTone> = { ok: 'good', watch: 'warn', understaffed: 'danger' };
export const MODE_LABEL: Record<string, string> = { OPEN_PICKUP: 'open pickup', AUTO_ASSIGN: 'auto-assign' };

function columns(refs: Record<string, number>): Column<QueueAnalyticsRow>[] {
  return [
    { key: 'queue', header: 'Queue', cell: (q) => <CellTitle title={q.name} caption={MODE_LABEL[q.mode] ?? q.mode.toLowerCase()} /> },
    {
      key: 'waiting',
      header: 'Waiting',
      cell: (q) => (
        <span className="mono">
          {q.waiting}
          {q.oldestWaitingSince ? <span className="mono-sm" style={{ display: 'block' }}>oldest {formatAge(q.oldestWaitingSince)}</span> : null}
        </span>
      ),
    },
    { key: 'shift', header: 'On shift', cell: (q) => <span className="mono">{`${q.onShift} / ${q.members}`}</span> },
    { key: 'wait', header: <Th note={refs['queues.avgWaitSeconds']}>Avg wait</Th>, cell: (q) => <span className="mono">{formatDuration(q.avgWaitSeconds)}</span> },
    { key: 'picked', header: 'Picked up', cell: (q) => <span className="mono">{formatNumber(q.pickedUp)}</span> },
    {
      key: 'now',
      header: 'Breached now',
      cell: (q) => (
        <span className="mono" style={q.breaches > 0 ? { color: 'var(--danger)', fontWeight: 600 } : undefined}>
          {q.breaches}
        </span>
      ),
    },
    { key: 'window', header: <Th note={refs['queues.slaBreachesInWindow']}>Breaches</Th>, cell: (q) => <span className="mono">{q.slaBreachesInWindow}</span> },
    { key: 'state', header: <Th note={refs['queues.state']}>State</Th>, cell: (q) => <StatusChip tone={STATE[q.state]}>{q.state}</StatusChip> },
  ];
}

/** Queue workload and pickup performance (GET /v1/analytics/queues, design/06 .dt-q). */
export function QueueAnalyticsTable({ data, refs }: { data: QueueAnalytics; refs: Record<string, number> }) {
  return (
    <DataTable
      label="Queue performance"
      columns={columns(refs)}
      rows={data.queues}
      rowKey={(q) => q.queueId}
      template="minmax(0,1.4fr) 76px 70px 76px 70px 84px 72px 96px"
      empty={
        <EmptyState title="No queues configured" actions={<Link className="btn tiny" href="/queues">Queues</Link>}>
          Escalations route to queues; each queue&apos;s waiting count, staffing, average wait and SLA breaches appear here.
        </EmptyState>
      }
    />
  );
}
