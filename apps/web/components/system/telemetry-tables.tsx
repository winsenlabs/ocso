import { DataTable } from '@/components/ui/data-table';
import { EmptyState } from '@/components/ui/empty-state';
import type { LatencySeries, ProviderHealth, TokenUsage } from '@/lib/api/telemetry';
import { formatCompact, formatDateTime, formatLatency, formatNumber, formatPercent } from '@/lib/format';
import { cacheLabel, formatMoney } from './system-meta';

const cache = (v: number | null) => (v === null ? 'n/r' : formatCompact(v));

/** Usage by model profile today: tokens, prompt-cache reads/writes, cached share and cost. */
export function ProfileUsageTable({ usage }: { usage: TokenUsage }) {
  return (
    <DataTable
      label="Usage by model profile"
      template="minmax(0,1.2fr) 70px 78px 78px 78px 78px 72px 90px"
      rows={usage.byProfile}
      rowKey={(p) => p.profileId ?? 'none'}
      empty={<EmptyState title="No model requests today">Usage per model profile appears with the first request.</EmptyState>}
      columns={[
        { key: 'profile', header: 'Profile', cell: (p) => <b style={{ fontSize: 12.5 }}>{p.profileName ?? 'no profile'}</b> },
        { key: 'req', header: 'Requests', cell: (p) => <span className="mono">{formatNumber(p.requests)}</span> },
        { key: 'in', header: 'Input', cell: (p) => <span className="mono">{formatCompact(p.inputTokens)}</span> },
        { key: 'out', header: 'Output', cell: (p) => <span className="mono">{formatCompact(p.outputTokens)}</span> },
        { key: 'cr', header: 'Cache read', cell: (p) => <span className="mono">{cache(p.cacheReadTokens)}</span> },
        { key: 'cw', header: 'Cache write', cell: (p) => <span className="mono">{cache(p.cacheWriteTokens)}</span> },
        { key: 'hit', header: 'Cached', cell: (p) => <span className="mono">{p.cachedInputShare === null ? 'n/r' : formatPercent(p.cachedInputShare, 0)}</span> },
        { key: 'cost', header: 'Cost', cell: (p) => <span className="mono">{formatMoney(p.costMicros, p.currency)}</span> },
      ]}
    />
  );
}

/** Usage and health by provider: today's tokens, observed cache read share and cost; last-hour latency and errors. */
export function ProviderUsageTable({ providers }: { providers: ProviderHealth[] }) {
  return (
    <DataTable
      label="Usage by provider"
      template="minmax(0,1.2fr) 80px 96px 80px 80px 80px 90px"
      rows={providers}
      rowKey={(p) => p.providerId}
      empty={<EmptyState title="No model provider configured">Provider usage appears once a provider serves requests.</EmptyState>}
      columns={[
        {
          key: 'name',
          header: 'Provider',
          cell: (p) => (
            <>
              <b style={{ fontSize: 12.5 }}>{p.name}</b>
              <span className="mono-sm" style={{ display: 'block' }}>
                {p.kind.toLowerCase()} · {p.region ?? 'no region'}
              </span>
            </>
          ),
        },
        { key: 'tok', header: 'Tokens today', cell: (p) => <span className="mono">{formatCompact(p.tokensToday)}</span> },
        { key: 'cache', header: 'Cache read', cell: (p) => <span className="mono">{cacheLabel(p.cacheReadShare, p.cacheSupport)}</span> },
        { key: 'req', header: 'Req · 1h', cell: (p) => <span className="mono">{formatNumber(p.requests1h)}</span> },
        { key: 'p95', header: 'p95 · 1h', cell: (p) => <span className="mono">{formatLatency(p.p95LatencyMs)}</span> },
        { key: 'err', header: 'Errors · 1h', cell: (p) => <span className="mono">{p.requests1h ? formatPercent(p.errorRate) : '—'}</span> },
        { key: 'cost', header: 'Cost today', cell: (p) => <span className="mono">{formatMoney(p.costTodayMicros, p.currency)}</span> },
      ]}
    />
  );
}

/** Slowest completed turns in the window; trace links only when OCSO_TRACE_URL_TEMPLATE is configured. */
export function SlowTurnsTable({ series, timeZone }: { series: LatencySeries; timeZone: string }) {
  return (
    <DataTable
      label="Slowest turns"
      template="minmax(0,1.2fr) 84px 84px minmax(0,1fr) 110px 90px"
      rows={series.slowestTurns}
      rowKey={(t) => t.turnId}
      empty={<EmptyState title="No completed turns in this window">The five slowest turns, with their traces, appear once agents answer.</EmptyState>}
      columns={[
        { key: 'turn', header: 'Turn', cell: (t) => <span className="mono-sm">{t.turnId}</span> },
        { key: 'lat', header: 'Latency', cell: (t) => <span className="mono">{formatLatency(t.latencyMs)}</span> },
        { key: 'ttft', header: 'TTFT', cell: (t) => <span className="mono">{formatLatency(t.ttftMs)}</span> },
        { key: 'model', header: 'Model', cell: (t) => <span className="mono-sm">{t.model ?? '—'}</span> },
        { key: 'at', header: 'Started', cell: (t) => <span className="mono-sm">{formatDateTime(t.startedAt, timeZone)}</span> },
        {
          key: 'trace',
          header: 'Trace',
          cell: (t) =>
            t.traceUrl ? (
              <a className="mono-sm" href={t.traceUrl} target="_blank" rel="noreferrer">
                open trace →
              </a>
            ) : (
              <span className="mono-sm" title={t.traceId ?? undefined}>
                {t.traceId ? 'no trace viewer' : 'not traced'}
              </span>
            ),
        },
      ]}
    />
  );
}
