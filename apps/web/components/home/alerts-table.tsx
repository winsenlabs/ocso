import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { AlertRow, AlertSeverity, AlertState } from '@/lib/api/alerts';
import { formatAge } from '@/lib/format';

const SEVERITY: Record<AlertSeverity, StatusTone> = { critical: 'danger', warning: 'warn', info: 'muted' };
const STATE: Record<AlertState, { tone: StatusTone; label: string }> = {
  open: { tone: 'warn', label: 'unacked' },
  investigating: { tone: 'accent', label: 'investigating' },
  acknowledged: { tone: 'muted', label: 'acked' },
  resolved: { tone: 'good', label: 'resolved' },
};

const COLUMNS: Column<AlertRow>[] = [
  { key: 'alert', header: 'Alert', cell: (a) => <CellTitle title={a.title} caption={a.detail} /> },
  { key: 'severity', header: 'Severity', cell: (a) => <StatusChip tone={SEVERITY[a.severity]}>{a.severity}</StatusChip> },
  { key: 'source', header: 'Source', cell: (a) => <span className="mono-sm">{a.source}</span> },
  { key: 'age', header: 'Age', cell: (a) => <span className="mono">{formatAge(a.openedAt)}</span> },
  { key: 'state', header: 'State', cell: (a) => <StatusChip tone={STATE[a.state].tone}>{STATE[a.state].label}</StatusChip> },
];

/** Open incidents and alerts for the user's audience (docs/11 §6). */
export function AlertsTable({ rows }: { rows: AlertRow[] | null }) {
  if (rows === null) {
    return (
      <EmptyState title="No alert feed yet">
        Open incidents and alerts for your audience — severity, source, age and acknowledgement — will be listed here once alert rules are
        evaluated by the API.
      </EmptyState>
    );
  }
  return (
    <DataTable
      label="Open incidents and alerts"
      columns={COLUMNS}
      rows={rows}
      rowKey={(a) => a.id}
      template="minmax(0,1.5fr) 104px 118px 92px 96px"
      empty={<EmptyState title="No open alerts">Nothing needs attention right now.</EmptyState>}
    />
  );
}
