import Link from 'next/link';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { ControlState, controlStateKind, type ControlStateKind } from '@/components/ui/control-state';
import { EmptyState } from '@/components/ui/empty-state';
import { SlaTimer } from '@/components/ui/sla-timer';
import type { AssignmentRow, PickupRow, SlaView } from '@/lib/api/conversations';
import { formatClock, formatTime } from '@/lib/format';

/** Column widths from design/06 (.dt-h). */
const TEMPLATE = 'minmax(0,1.5fr) 104px 118px 92px 96px';

function slaLabel(sla: SlaView): string {
  return sla.level === 'breach' ? 'breached' : formatClock(sla.remainingSeconds);
}

/** Customer cell that opens the conversation in the workspace (design/01). */
function customerLink(conversationId: string, name: string) {
  return <Link href={`/conversations/${conversationId}`}>{name}</Link>;
}

const PICKUP_COLUMNS: Column<PickupRow>[] = [
  { key: 'customer', header: 'Customer', cell: (r) => <CellTitle title={customerLink(r.conversationId, r.customerName)} caption={r.customerRef} /> },
  { key: 'agent', header: 'Agent', cell: (r) => <span className="mono-sm">{r.agentName}</span> },
  { key: 'reason', header: 'Reason', cell: (r) => <span className="mono-sm">{r.reason}</span> },
  { key: 'waiting', header: 'Waiting', cell: (r) => <span className="mono">{formatClock(r.waitingSeconds)}</span> },
  {
    key: 'sla',
    header: 'SLA',
    cell: (r) => (r.sla ? <SlaTimer level={r.sla.level} progress={r.sla.progress} label={slaLabel(r.sla)} /> : <span className="mono-sm">no sla</span>),
  },
];

/** Pickup queue: conversations waiting for a human in the user's queues. */
export function PickupQueueTable({ rows }: { rows: PickupRow[] | null }) {
  if (rows === null) {
    return (
      <EmptyState title="Pickup queue could not be loaded">
        Conversations waiting for a human in your queues are listed here, oldest first, with their SLA clock. Reload to try again.
      </EmptyState>
    );
  }
  return (
    <DataTable
      label="Pickup queue"
      columns={PICKUP_COLUMNS}
      rows={rows}
      rowKey={(r) => r.conversationId}
      template={TEMPLATE}
      empty={<EmptyState title="Nobody is waiting">No conversation in your queues needs a human right now.</EmptyState>}
    />
  );
}

/** Short control labels used in "Assigned to me" (design/06). */
const ASSIGNED_LABEL: Record<ControlStateKind, string> = {
  ai: 'ai active',
  wait: 'waiting',
  human: 'you',
  returning: 'returning',
  resolved: 'resolved',
};

export function assignmentColumns(timeZone: string): Column<AssignmentRow>[] {
  return [
    { key: 'customer', header: 'Customer', cell: (r) => <CellTitle title={customerLink(r.conversationId, r.customerName)} caption={r.topic} /> },
    { key: 'agent', header: 'Agent', cell: (r) => <span className="mono-sm">{r.agentName}</span> },
    {
      key: 'control',
      header: 'Control',
      cell: (r) => {
        const kind = controlStateKind(r.controlState);
        return <ControlState state={kind}>{ASSIGNED_LABEL[kind]}</ControlState>;
      },
    },
    { key: 'last', header: 'Last turn', cell: (r) => <span className="mono-sm">{formatTime(r.lastTurnAt, timeZone)}</span> },
    { key: 'sla', header: 'SLA', cell: (r) => <span className="mono-sm">{r.sla ? slaLabel(r.sla) : '—'}</span> },
  ];
}

/** Conversations the signed-in exec is handling. */
export function AssignmentsTable({ rows, timeZone }: { rows: AssignmentRow[] | null; timeZone: string }) {
  if (rows === null) {
    return (
      <EmptyState title="Assignments could not be loaded">
        Conversations you have claimed or been assigned — with who is in control and time to SLA — are listed here. Reload to try again.
      </EmptyState>
    );
  }
  return (
    <DataTable
      label="Assigned to me"
      columns={assignmentColumns(timeZone)}
      rows={rows}
      rowKey={(r) => r.conversationId}
      template={TEMPLATE}
      empty={<EmptyState title="Nothing assigned">Claim a conversation from the pickup queue to start.</EmptyState>}
    />
  );
}
