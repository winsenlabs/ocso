import Link from 'next/link';
import { CellTitle, DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { listExceptionReports, type ExceptionReportSummary } from '@/lib/api/exceptions';
import { formatDateTime } from '@/lib/format';
import { AdhocReportForm } from './adhoc-form';
import { periodLabel } from './exceptions-meta';

/** Weekly (and ad-hoc) reports, newest period first: status, who signed, the item counts. */
export async function ReportsList({ timeZone, canSign, cursor }: { timeZone: string; canSign: boolean; cursor: { before?: string | undefined; beforeId?: string | undefined } }) {
  const page = await listExceptionReports({ ...cursor, limit: 25 });
  const next = page.next ? `/exceptions?view=reports&before=${encodeURIComponent(page.next.before)}&beforeId=${page.next.beforeId}` : null;
  return (
    <>
      <DataTable<ExceptionReportSummary>
        label="Exception reports"
        template="minmax(200px,1.4fr) 110px minmax(160px,1fr) 150px"
        rows={page.rows}
        rowKey={(r) => r.id}
        empty={
          <EmptyState title="No report yet.">
            Every Monday the worker freezes the previous week (deployment time zone) into a report for a Head to sign. The live view shows what it would contain today.
          </EmptyState>
        }
        columns={[
          {
            key: 'period',
            header: 'Period',
            cell: (r) => (
              <CellTitle
                title={<Link href={`/exceptions/reports/${r.id}`}>{periodLabel(r.periodStart, r.periodEnd, r.timezone)}</Link>}
                caption={`${r.kind === 'WEEKLY' ? 'Weekly' : `Ad hoc · ${r.generatedBy?.name ?? ''}`} · generated ${formatDateTime(r.generatedAt, timeZone)}`}
              />
            ),
          },
          {
            key: 'status',
            header: 'Status',
            cell: (r) => (
              <StatusChip tone={r.status === 'SIGNED' ? 'good' : r.status === 'SUPERSEDED' ? 'muted' : 'warn'}>
                {r.status === 'SIGNED' ? (r.attestation.includes('self_attested') ? 'signed · self-attested' : 'signed') : r.status === 'SUPERSEDED' ? 'superseded' : 'to sign'}
              </StatusChip>
            ),
          },
          {
            key: 'signed',
            header: 'Signed',
            cell: (r) => (r.signedAt ? <CellTitle title={r.signedBy?.name ?? '—'} caption={formatDateTime(r.signedAt, timeZone)} /> : <span className="mono-sm">not yet</span>),
          },
          {
            key: 'items',
            header: itemsHeader(page.rows),
            cell: (r) => (
              <span className="mono-sm">
                {r.totals.items} item{r.totals.items === 1 ? '' : 's'}
                {r.totals.bySeverity['critical'] ? ` · ${r.totals.bySeverity['critical']} critical` : ''}
              </span>
            ),
          },
        ]}
      />
      {next ? (
        <div style={{ marginTop: 10 }}>
          <Link className="btn tiny ghost" href={next}>
            Older reports
          </Link>
        </div>
      ) : null}
      {canSign ? <AdhocReportForm /> : null}
    </>
  );
}

function itemsHeader(rows: readonly ExceptionReportSummary[]): string {
  return rows.some((r) => r.scoped) ? 'Items (your teams)' : 'Items';
}
