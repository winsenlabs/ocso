import { StatusChip, type StatusTone } from '@/components/ui/status-chip';
import type { HealthSample } from '@/lib/api/mcp';
import { formatDateTime, formatLatency } from '@/lib/format';

const TONE: Record<string, StatusTone> = { HEALTHY: 'good', DEGRADED: 'warn', DOWN: 'danger', AUTH_REQUIRED: 'warn' };
const DOT: Record<string, string> = { HEALTHY: 'var(--good)', DEGRADED: 'var(--warn)', DOWN: 'var(--danger)', AUTH_REQUIRED: 'var(--warn)' };
const W = 300;
const H = 36;

/**
 * Health history (GET /v1/mcp/connections/:id/health): a latency sparkline,
 * oldest → newest, with each check as a status-coloured point (hover for the
 * status, latency and time), and the recent checks as a list — the table
 * view, so status never relies on colour alone.
 */
export function HealthHistory({ samples, timezone }: { samples: HealthSample[]; timezone: string }) {
  if (!samples.length) return <span className="mono-sm">No health checks yet. Checks start after approval and run on the connection’s interval.</span>;
  const ordered = [...samples].reverse();
  const latencies = ordered.map((s) => s.latencyMs ?? 0);
  const max = Math.max(1, ...latencies);
  const x = (i: number) => (ordered.length === 1 ? W / 2 : (i / (ordered.length - 1)) * W);
  const y = (v: number) => H - 4 - (v / max) * (H - 8);
  const failing = samples.filter((s) => s.status !== 'HEALTHY').length;
  const label = `Health check latency, last ${samples.length} checks: ${failing} not healthy, peak ${formatLatency(max)}`;
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <svg className="spark health-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label}>
        <title>{label}</title>
        <polyline fill="none" stroke="var(--ink-3)" strokeWidth="2" vectorEffect="non-scaling-stroke" points={ordered.map((s, i) => `${x(i)},${y(s.latencyMs ?? 0)}`).join(' ')} />
        {ordered.map((s, i) => (
          <circle key={s.sampledAt + i} cx={x(i)} cy={y(s.latencyMs ?? 0)} r={s.status === 'HEALTHY' ? 2 : 3.5} fill={DOT[s.status] ?? 'var(--ink-4)'} stroke="var(--surface)" strokeWidth="1">
            <title>{`${s.status.toLowerCase()} · ${formatLatency(s.latencyMs)} · ${formatDateTime(s.sampledAt, timezone)}`}</title>
          </circle>
        ))}
      </svg>
      <div className="ax" aria-hidden="true">
        <span>{formatDateTime(ordered[0]?.sampledAt, timezone)}</span>
        <span>peak {formatLatency(max)}</span>
        <span>{formatDateTime(ordered[ordered.length - 1]?.sampledAt, timezone)}</span>
      </div>
      <div className="minitable health-list" role="table" aria-label="Recent health checks">
        <div className="r h" role="row">
          <span role="columnheader">Checked</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="n">
            Latency
          </span>
        </div>
        {samples.slice(0, 8).map((s, i) => (
          <div className="r" role="row" key={s.sampledAt + i} title={s.detail ?? undefined}>
            <span role="cell" className="mono-sm">
              {formatDateTime(s.sampledAt, timezone)}
            </span>
            <span role="cell">
              <StatusChip tone={TONE[s.status] ?? 'muted'}>{s.status.toLowerCase().replace(/_/g, ' ')}</StatusChip>
            </span>
            <span role="cell" className="n">
              {formatLatency(s.latencyMs)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
