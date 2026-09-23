'use client';

import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { DataTable } from '@/components/ui/data-table';
import { StatusChip } from '@/components/ui/status-chip';
import { approvalsHref, type ApprovalsParams } from './approvals-meta';
import { BulkBar } from './bulk-bar';
import { ageLabel, statusChip } from './lib/labels';
import type { ProposalListItem } from './lib/schemas';
import { exclusionReason, excluded, selectAll } from './lib/selection';

export interface ApprovalsTableProps {
  rows: ProposalListItem[];
  meId: string;
  /** Awaiting me: rows get a bulk-approve checkbox. */
  canCheck: boolean;
  selectedId: string | null;
  /** Current filters; each row links to the same view with its drawer open. */
  linkParams: ApprovalsParams;
  empty: ReactNode;
}

/**
 * The approval queue table. On "Awaiting me" every row has a checkbox; rows
 * with a blocking warning are disabled with the reason as their title, and
 * the bulk bar approves the rest in one call (per-item decisions server-side).
 */
export function ApprovalsTable({ rows, meId, canCheck, selectedId, linkParams, empty }: ApprovalsTableProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectable = useMemo(() => selectAll(rows, meId), [rows, meId]);
  const left = useMemo(() => excluded(rows, meId), [rows, meId]);
  const chosen = rows.filter((r) => selected.has(r.id) && selectable.includes(r.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOn = selectable.length > 0 && selectable.every((id) => selected.has(id));

  const columns = [
    ...(canCheck
      ? [
          {
            key: 'select',
            header: (
              <input
                type="checkbox"
                aria-label="Select all that can be approved together"
                checked={allOn}
                disabled={!selectable.length}
                onChange={() => setSelected(allOn ? new Set() : new Set(selectable))}
              />
            ),
            cell: (r: ProposalListItem) => {
              const reason = exclusionReason(r, meId);
              return (
                <input
                  type="checkbox"
                  aria-label={`Select ${r.title}`}
                  title={reason ?? undefined}
                  disabled={reason !== null}
                  checked={reason === null && selected.has(r.id)}
                  onChange={() => toggle(r.id)}
                />
              );
            },
          },
        ]
      : []),
    {
      key: 'change',
      header: 'Change',
      cell: (r: ProposalListItem) => (
        <Link className="cell-btn" href={approvalsHref({ ...linkParams, approval: r.id })} scroll={false}>
          <span className="ap-row-title">
            {r.warnings.some((w) => w.blocksBulk) ? <span className="ap-dot" title={r.warnings.map((w) => w.message).join(' ')} aria-label="Has warnings" /> : null}
            <b style={{ fontSize: 12.5 }}>{r.title}</b>
          </span>
          <span className="mono-sm" style={{ display: 'block' }}>
            {r.objectLabel} · {r.changedFields.length ? r.changedFields.slice(0, 4).join(', ') : r.action.toLowerCase()}
            {r.revision > 1 ? ` · revision ${r.revision}` : ''}
          </span>
        </Link>
      ),
    },
    { key: 'maker', header: 'Maker', cell: (r: ProposalListItem) => <span className="mono-sm">{r.maker?.name ?? 'migration'}</span> },
    {
      key: 'checker',
      header: 'Checker',
      cell: (r: ProposalListItem) => (
        <span className="mono-sm">
          {r.checker?.name ?? '—'}
          {!r.checkerValid ? (
            <StatusChip tone="danger" title="The named checker can no longer approve this">
              needs checker
            </StatusChip>
          ) : null}
        </span>
      ),
    },
    { key: 'age', header: 'Age', cell: (r: ProposalListItem) => <span className="mono">{ageLabel(r.ageSeconds)}</span> },
    {
      key: 'status',
      header: 'Status',
      cell: (r: ProposalListItem) => {
        const chip = statusChip(r);
        return <StatusChip tone={chip.tone}>{chip.label}</StatusChip>;
      },
    },
  ];

  return (
    <>
      <DataTable
        label="Approvals"
        template={`${canCheck ? '28px ' : ''}minmax(0,1.8fr) minmax(0,0.7fr) minmax(0,0.8fr) 60px 110px`}
        rows={rows}
        rowKey={(r) => r.id}
        selectedKey={selectedId}
        empty={empty}
        columns={columns}
      />
      {canCheck && (chosen.length > 0 || left.length > 0) ? (
        <BulkBar
          items={chosen.map((r) => ({ id: r.id, contentHash: r.contentHash }))}
          excludedCount={left.length}
          firstExcludedHref={left[0] ? approvalsHref({ ...linkParams, approval: left[0].id }) : null}
          onDone={() => setSelected(new Set())}
        />
      ) : null}
    </>
  );
}
