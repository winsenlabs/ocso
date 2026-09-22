/** Bar tones from charts.css: default ink, w(arn), d(anger), a(ccent), g(ood). */
export type BarTone = 'default' | 'w' | 'd' | 'a' | 'g';

export interface HBarRow {
  label: string;
  /** Bar length as a share of the track, 0–1. */
  share: number;
  /** Right-hand value as displayed, e.g. "312" or "72%". */
  display: string;
  tone?: BarTone;
}

export interface HBarChartProps {
  rows: HBarRow[];
  /** grid-template-columns override (label, bar, value). */
  columns?: string;
  label: string;
}

/** Horizontal bar list (.hb). Each row reads as "label value" to assistive tech. */
export function HBarChart({ rows, columns, label }: HBarChartProps) {
  return (
    <div className="hb" style={columns ? { gridTemplateColumns: columns } : undefined} role="list" aria-label={label}>
      {rows.map((row) => {
        const pct = Math.round(Math.min(1, Math.max(0, row.share)) * 100);
        const tone = row.tone && row.tone !== 'default' ? row.tone : undefined;
        return (
          <div key={row.label} role="listitem" style={{ display: 'contents' }}>
            <span>{row.label}</span>
            <span className="bar" aria-hidden="true">
              <i className={tone} style={{ width: `${pct}%` }} />
            </span>
            <span className="n">{row.display}</span>
          </div>
        );
      })}
    </div>
  );
}
