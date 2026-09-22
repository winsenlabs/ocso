import Link from 'next/link';
import { Permission } from '@ocso/auth';
import { NotPermitted } from '@/components/shell/placeholder-page';
import { CellTitle, DataTable, type Column } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import { LegendKey, LineChart } from '@/components/ui/line-chart';
import { ChartCard } from '@/components/ui/rail-card';
import { SecHead } from '@/components/ui/sec-head';
import { StatusChip } from '@/components/ui/status-chip';
import { Tiles } from '@/components/ui/tile';
import { loadEscalationReasonsReport, type EscalationReasonTrend, type EscalationReasons } from '@/lib/api/analytics';
import { hasPermission, requireSession } from '@/lib/session';
import { countDelta, formatNumber, formatPercent, humanizeCode, numberNotes, parseDays, reasonLabels, reasonSeries, share, shortDay, windowLabel } from './metrics';
import { param, type SearchParams } from './params';
import { Definitions, Fn, MetricTile, Th, WindowBar } from './parts';

const SERIES_COLORS = ['var(--warn)', 'var(--ink)', 'var(--accent)', 'var(--danger)', 'var(--ink-4)'];

type Row = EscalationReasonTrend & { label: string };

function change(r: EscalationReasonTrend): string {
  if (r.previous === 0) return 'new';
  const d = r.count - r.previous;
  return d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${Math.abs(d)}`;
}

function splitText(items: EscalationReasonTrend['agents'], none: string): string {
  if (!items.length) return '—';
  const shown = items.slice(0, 2).map((s) => `${s.name ?? none} ${s.count}`);
  return items.length > 2 ? `${shown.join(' · ')} · +${items.length - 2}` : shown.join(' · ');
}

function columns(total: number, refs: Record<string, number>): Column<Row>[] {
  return [
    { key: 'reason', header: 'Reason', cell: (r) => <CellTitle title={r.label} caption={r.example ?? r.reasonCode} /> },
    { key: 'trigger', header: 'Trigger', cell: (r) => <StatusChip tone={r.trigger === 'TOOL_FAILURE' ? 'danger' : r.trigger === 'CUSTOMER_REQUEST' ? 'muted' : 'warn'}>{humanizeCode(r.trigger).toLowerCase()}</StatusChip> },
    { key: 'count', header: 'Handoffs', cell: (r) => <span className="mono">{formatNumber(r.count)}</span> },
    {
      key: 'share',
      header: 'Share',
      cell: (r) => (
        <span className="ops-share">
          <span className="util" aria-hidden="true">
            <i className="w" style={{ width: `${Math.round(share(r.count, total) * 100)}%` }} />
          </span>
          <span className="mono-sm">{formatPercent(share(r.count, total), 0)}</span>
        </span>
      ),
    },
    { key: 'prev', header: <Th note={refs['previous']}>vs prev.</Th>, cell: (r) => <span className="mono" title={`${r.previous} in the previous window`}>{change(r)}</span> },
    { key: 'agents', header: <Th note={refs['split']}>Agents</Th>, cell: (r) => <span className="mono-sm">{splitText(r.agents, 'unknown')}</span> },
    { key: 'queues', header: 'Routed to', cell: (r) => <span className="mono-sm">{splitText(r.queues, 'no queue')}</span> },
  ];
}

function Trend({ data, refs }: { data: EscalationReasons; refs: Record<string, number> }) {
  // Daily buckets are per reason code (all triggers of a code together).
  const series = reasonSeries(data.daily, data.reasons.map((r) => r.reasonCode)).map((s, i) => ({
    label: s.reasonCode === 'other' ? 'Other reasons' : humanizeCode(s.reasonCode),
    color: SERIES_COLORS[i] ?? 'var(--ink-3)',
    values: s.values,
  }));
  const first = data.daily[0];
  const last = data.daily[data.daily.length - 1];
  const peak = Math.max(1, ...data.daily.map((d) => d.total));
  return (
    <ChartCard
      title={`Escalations per day by reason · ${data.daily.length} day${data.daily.length === 1 ? '' : 's'}`}
      meta={
        <>
          {series.map((s) => (
            <LegendKey key={s.label} color={s.color} label={s.label.toLowerCase()} />
          ))}
          <Fn n={refs['daily']} />
        </>
      }
    >
      <LineChart
        label={`Escalations per day for the top reasons, ${windowLabel(data.window.days)}`}
        series={series}
        domain={[0, peak * 1.15]}
        {...(first && last ? { axis: [{ text: shortDay(first.day) }, { text: shortDay(last.day) }] } : {})}
      />
      <div className="foot">
        <span className="mono-sm">peak {peak} handoff{peak === 1 ? '' : 's'} on a day · days by conversation opened, {data.window.timezone}</span>
      </div>
    </ChartCard>
  );
}

/** Why virtual agents hand conversations to humans, ranked and trended (GET /v1/analytics/escalation-reasons). */
export async function EscalationReasonsBody({ searchParams }: { searchParams: SearchParams }) {
  const [session, params] = await Promise.all([requireSession(), searchParams]);
  if (!hasPermission(session, Permission.ANALYTICS_BUSINESS_READ)) return <NotPermitted role={session.roleLabel} />;
  const days = parseDays(param(params, 'days'));
  const data = await loadEscalationReasonsReport(days);
  const notes = numberNotes([
    ['reasons', data.definitions.reasons],
    ['previous', data.definitions.previous],
    ['daily', data.definitions.daily],
    ['split', data.definitions.split],
  ]);
  const labels = reasonLabels(data.reasons);
  const rows: Row[] = data.reasons.map((r, i) => ({ ...r, label: labels[i] ?? r.reasonCode }));
  const top = rows[0];

  return (
    <>
      <WindowBar basePath="/escalation-reasons" days={days} window={data.window} extra={<Link className="btn tiny ghost" href={`/analytics?days=${days}`}>Analytics</Link>} />
      <Tiles min={160}>
        <MetricTile label="escalations" value={formatNumber(data.total)} delta={countDelta(data.total, data.previousTotal)} definition={data.definitions.reasons} note={notes.refs['reasons']} />
        <MetricTile label="previous window" value={formatNumber(data.previousTotal)} definition={data.definitions.previous} note={notes.refs['previous']} />
        <MetricTile label="distinct reasons" value={data.total ? formatNumber(rows.length) : null} definition={data.definitions.reasons} note={notes.refs['reasons']} />
        <MetricTile label={top ? `top · ${top.label.toLowerCase()}` : 'top reason'} value={top ? formatPercent(share(top.count, data.total), 0) : null} definition={data.definitions.reasons} note={notes.refs['reasons']} caption={top ? `${top.count} of ${data.total}` : undefined} />
      </Tiles>

      {data.total === 0 ? (
        <EmptyState title={`No escalations in the ${windowLabel(days)}`}>
          Handoffs requested by an agent, a rule, a policy or the customer appear here, grouped by reason code and trigger. Staff take-overs are not escalations and are
          not counted.
        </EmptyState>
      ) : (
        <>
          <Trend data={data} refs={notes.refs} />
          <SecHead title="Reasons" count={rows.length} desc="ranked by handoffs in the window" style={{ marginTop: 18 }} />
          <div className="ops-scroll">
            <DataTable label="Escalation reasons" columns={columns(data.total, notes.refs)} rows={rows} rowKey={(r) => `${r.reasonCode}:${r.trigger}`} template="minmax(180px,1.5fr) 118px 70px 110px 64px minmax(0,1fr) minmax(0,1fr)" />
          </div>
        </>
      )}
      <Definitions notes={notes.list} />
    </>
  );
}
