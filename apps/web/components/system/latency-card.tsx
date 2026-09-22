import { EmptyState } from '@/components/ui/empty-state';
import { LegendKey } from '@/components/ui/line-chart';
import type { LatencySeries } from '@/lib/api/telemetry';
import { formatLatency, formatTime } from '@/lib/format';
import { bucketMax } from './system-meta';

const WIDTH = 300;
const HEIGHT = 100;
const POINTS = 60;

/** Polyline segments that break at missing minutes instead of inventing values. */
function segments(values: Array<number | null>, y: (v: number) => number): string[] {
  const x = (i: number) => (values.length <= 1 ? WIDTH / 2 : (i / (values.length - 1)) * WIDTH);
  const out: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) out.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${Math.round(x(i) * 10) / 10},${Math.round(y(v) * 10) / 10}`);
  });
  if (current.length) out.push(current.join(' '));
  // A lone point still needs two coordinates to draw.
  return out.map((s) => (s.includes(' ') ? s : `${s} ${s}`));
}

/**
 * Latency · last N minutes (design/03): per-minute p95 turn latency and TTFT,
 * with a marker at the first minute providers errored or fell back. Gaps are
 * minutes without completed turns.
 */
export function LatencyCard({ series, timeZone }: { series: LatencySeries; timeZone: string }) {
  const turn = bucketMax(series.points.map((p) => p.turnP95Ms), POINTS);
  const ttft = bucketMax(series.points.map((p) => p.ttftP95Ms), POINTS);
  const all = [...turn, ...ttft].filter((v): v is number => v !== null);
  const trace = series.slowestTurns.find((t) => t.traceUrl)?.traceUrl ?? null;
  const first = series.points[0]?.minute ?? null;
  const last = series.points[series.points.length - 1]?.minute ?? null;
  const marker = series.markers[0] ?? null;
  const span = first && last ? Date.parse(last) - Date.parse(first) : 0;
  const markerX = marker && first && span > 0 ? ((Date.parse(marker.minute) - Date.parse(first)) / span) * WIDTH : null;
  const max = all.length ? Math.max(...all) * 1.15 : 1;
  const y = (v: number) => HEIGHT - (v / max) * HEIGHT;

  return (
    <section className="ch" aria-label={`Latency, last ${series.minutes} minutes`}>
      <div className="t">
        <h3>Latency · last {series.minutes} minutes</h3>
        <LegendKey color="var(--ink)" label="turn p95" />
        <LegendKey color="var(--accent)" label="ttft p95" />
        {trace ? (
          <a className="mono-sm" style={{ marginLeft: 'auto' }} href={trace} target="_blank" rel="noreferrer">
            slowest trace →
          </a>
        ) : null}
      </div>
      {all.length === 0 ? (
        <EmptyState size="sm" title="No completed turns in this window">
          Per-minute p95 turn latency and time to first token appear once agents answer conversations.
        </EmptyState>
      ) : (
        <>
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" style={{ height: HEIGHT }} role="img" aria-label="p95 turn latency and time to first token per minute">
            <title>{`Peak turn p95 ${formatLatency(Math.max(...turn.filter((v): v is number => v !== null), 0))}`}</title>
            <line x1="0" y1={HEIGHT * 0.34} x2={WIDTH} y2={HEIGHT * 0.34} stroke="var(--border)" strokeDasharray="2 4" />
            <line x1="0" y1={HEIGHT * 0.66} x2={WIDTH} y2={HEIGHT * 0.66} stroke="var(--border)" strokeDasharray="2 4" />
            {segments(turn, y).map((pts) => (
              <polyline key={`t${pts}`} fill="none" stroke="var(--ink)" strokeWidth="2" points={pts} />
            ))}
            {segments(ttft, y).map((pts) => (
              <polyline key={`f${pts}`} fill="none" stroke="var(--accent)" strokeWidth="2" points={pts} />
            ))}
            {markerX !== null ? <line x1={markerX} y1="0" x2={markerX} y2={HEIGHT} stroke="var(--danger)" strokeWidth="1.5" /> : null}
          </svg>
          <div className="ax" aria-hidden="true">
            <span>{formatTime(first, timeZone)}</span>
            {marker ? (
              <span style={{ color: 'var(--danger)' }}>
                {formatTime(marker.minute, timeZone)} {marker.providerName ?? 'provider'} {marker.kind === 'fallback' ? 'fallback' : (marker.errorCategory ?? 'errors').toLowerCase()}
              </span>
            ) : null}
            <span>{formatTime(last, timeZone)}</span>
          </div>
        </>
      )}
      <div className="foot">
        <span className="mono-sm">
          {series.markers.length
            ? `${series.markers.length} provider incident minute${series.markers.length === 1 ? '' : 's'} (errors or fallbacks) in the window`
            : 'no provider errors or fallbacks in the window'}
        </span>
      </div>
    </section>
  );
}
