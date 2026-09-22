export interface LineSeries {
  label: string;
  /** CSS colour, e.g. "var(--ink)" or "var(--accent)". */
  color: string;
  values: number[];
}

export interface LineMarker {
  /** Index into the series values where the vertical marker sits. */
  at: number;
  color: string;
  dashed?: boolean;
}

export interface LineChartProps {
  series: LineSeries[];
  /** Accessible summary of what the chart shows. */
  label: string;
  height?: number;
  /** Dashed horizontal guides as fractions of the height (design: two). */
  guides?: number[];
  markers?: LineMarker[];
  /** Axis captions under the chart (left, [middle], right). */
  axis?: Array<{ text: string; color?: string }>;
  /** Fixed value domain; defaults to the data range with padding. */
  domain?: [number, number];
}

const WIDTH = 300;

/** Pure-SVG polyline chart (as in the design's latency / containment charts). */
export function LineChart({ series, label, height = 96, guides = [0.25, 0.58], markers = [], axis, domain }: LineChartProps) {
  const all = series.flatMap((s) => s.values);
  const [min, max] = domain ?? paddedRange(all);
  const span = max - min || 1;
  const longest = Math.max(1, ...series.map((s) => s.values.length));
  const x = (i: number) => (longest === 1 ? WIDTH / 2 : (i / (longest - 1)) * WIDTH);
  const y = (v: number) => height - ((v - min) / span) * height;

  return (
    <>
      <svg viewBox={`0 0 ${WIDTH} ${height}`} preserveAspectRatio="none" style={{ height }} role="img" aria-label={label}>
        <title>{label}</title>
        {guides.map((g) => (
          <line key={g} x1="0" y1={g * height} x2={WIDTH} y2={g * height} stroke="var(--border)" strokeDasharray="2 4" />
        ))}
        {series.map((s) => (
          <polyline
            key={s.label}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            points={s.values.map((v, i) => `${round(x(i))},${round(y(v))}`).join(' ')}
          />
        ))}
        {markers.map((m) => (
          <line
            key={`${m.at}-${m.color}`}
            x1={x(m.at)}
            y1="0"
            x2={x(m.at)}
            y2={height}
            stroke={m.color}
            strokeWidth="1.5"
            strokeDasharray={m.dashed ? '3 3' : undefined}
          />
        ))}
      </svg>
      {axis?.length ? (
        <div className="ax" aria-hidden="true">
          {axis.map((a) => (
            <span key={a.text} style={a.color ? { color: a.color } : undefined}>
              {a.text}
            </span>
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Legend chip (.lg) for a series. */
export function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="lg">
      <i style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function paddedRange(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = (hi - lo || Math.abs(hi) || 1) * 0.15;
  return [lo - pad, hi + pad];
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
