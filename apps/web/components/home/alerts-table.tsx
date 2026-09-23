import Link from 'next/link';
import { SeverityChip, StateChip } from '@/components/alerts/alert-chips';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import type { AdminIncident } from '@/lib/api/home';
import { formatAge } from '@/lib/format';

const COLUMNS: Column<AdminIncident>[] = [
  {
    key: 'alert',
    header: 'Alert',
    cell: (a) => <CellTitle title={<Link href={`/alerts?alert=${a.id}`}>{a.title}</Link>} caption={[a.value, a.occurrences > 1 ? `${a.occurrences}×` : null].filter(Boolean).join(' · ') || null} />,
  },
  { key: 'severity', header: 'Severity', cell: (a) => <SeverityChip severity={a.severity} /> },
  { key: 'source', header: 'Source', cell: (a) => <span className="mono-sm">{a.source}</span> },
  { key: 'age', header: 'Age', cell: (a) => <span className="mono">{formatAge(a.openedAt)}</span> },
  { key: 'state', header: 'State', cell: (a) => <StateChip status={a.status} /> },
];

/** Open technical incidents and alerts (design/06 admin), critical first. */
export function AlertsTable({ rows }: { rows: AdminIncident[] }) {
  return (
    <DataTable
      label="Open incidents and alerts"
      columns={COLUMNS}
      rows={rows}
      rowKey={(a) => a.id}
      template="minmax(0,1.5fr) 104px 118px 92px 96px"
      empty={<EmptyState title="No open incidents">No technical alert is open. Alert rules keep evaluating every minute.</EmptyState>}
    />
  );
}
