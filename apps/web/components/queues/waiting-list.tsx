'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { SlaTimer } from '@/components/ui/sla-timer';
import { StatusChip } from '@/components/ui/status-chip';
import { formatAge, formatClock } from '@/lib/format';
import { liveSla, rankBySla, type LiveSla } from './sla-live';

export interface WaitingRow {
  id: string;
  displayId: string;
  customerName: string | null;
  agentName: string;
  queueId: string | null;
  queueName: string | null;
  priority: string;
  controlState: string;
  waitingSince: string | null;
  slaDueAt: string | null;
  reason: string | null;
}

type Ranked = WaitingRow & { sla: LiveSla };

/** Ticks every `ms` after hydration; starts from the server's render time so HTML matches. */
function useClock(initial: number, ms = 1_000): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function timer(s: LiveSla) {
  if (s.level === 'none' || s.remainingSeconds === null) return <span className="mono-sm">no SLA policy</span>;
  const label = s.level === 'breach' ? `breached ${formatClock(s.remainingSeconds)}` : `${formatClock(s.remainingSeconds)} to SLA`;
  return <SlaTimer level={s.level} progress={s.progress ?? 0} label={label} />;
}

const COLUMNS = (showQueue: boolean): Column<Ranked>[] => [
  {
    key: 'conv',
    header: 'Conversation',
    cell: (r) => <CellTitle title={<Link href={`/conversations/${r.id}`}>{r.customerName ?? 'Unnamed customer'}</Link>} caption={`${r.displayId} · ${r.agentName}${r.reason ? ` · ${r.reason}` : ''}`} />,
  },
  ...(showQueue ? [{ key: 'queue', header: 'Queue', cell: (r: Ranked) => <span className="mono-sm">{r.queueName ?? 'no queue'}</span> }] : []),
  { key: 'prio', header: 'Priority', cell: (r) => <StatusChip tone={r.priority === 'P1' ? 'danger' : r.priority === 'P2' ? 'warn' : 'muted'}>{r.priority}</StatusChip> },
  { key: 'wait', header: 'Waiting', cell: (r) => <span className="mono">{formatAge(r.waitingSince)}</span> },
  { key: 'sla', header: 'Pickup SLA', cell: (r) => timer(r.sla) },
  {
    key: 'open',
    header: '',
    cell: (r) => (
      <Link className="btn tiny" href={`/conversations/${r.id}`}>
        Open
      </Link>
    ),
  },
];

/**
 * Conversations waiting for a human, most urgent first, with a live pickup
 * clock. `fractions` maps queue id → the queue policy's at-risk fraction.
 */
export function WaitingList({ rows, fractions, serverNow, label, showQueue = true, emptyText }: { rows: WaitingRow[]; fractions: Record<string, number>; serverNow: number; label: string; showQueue?: boolean; emptyText: string }) {
  const now = useClock(serverNow);
  const ranked = rankBySla(rows.map((r) => ({ ...r, sla: liveSla(r, (r.queueId ? fractions[r.queueId] : undefined) ?? 0.75, now) })));
  return (
    <DataTable
      label={label}
      columns={COLUMNS(showQueue)}
      rows={ranked}
      rowKey={(r) => r.id}
      template={showQueue ? 'minmax(0,1.6fr) minmax(0,1fr) 70px 70px 170px 64px' : 'minmax(0,1.6fr) 70px 70px 170px 64px'}
      empty={<EmptyState title="Nobody is waiting">{emptyText}</EmptyState>}
    />
  );
}
