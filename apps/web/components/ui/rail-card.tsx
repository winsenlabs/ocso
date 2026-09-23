import type { ReactNode } from 'react';

/** Right-rail card (.rail-card) with a mono uppercase heading and optional count. */
export function RailCard({ title, count, children }: { title: string; count?: ReactNode; children: ReactNode }) {
  return (
    <section className="rail-card" aria-label={title}>
      <h3>
        {title}
        {count !== undefined && count !== null ? <span className="count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

/** Chart / panel card (.ch) with a small heading row. */
export function ChartCard({ title, meta, children, tone }: { title: string; meta?: ReactNode; children: ReactNode; tone?: 'warn' | 'danger' }) {
  return (
    <section className={tone ? `ch ${tone}` : 'ch'} aria-label={title}>
      <div className="t">
        <h3>{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  );
}

export interface DayRow {
  key: string;
  time: string;
  label: ReactNode;
  who?: ReactNode;
  flag?: ReactNode;
}

/** Compact timestamped list (.day-list) used in rail cards. */
export function DayList({ rows }: { rows: DayRow[] }) {
  return (
    <div className="day-list">
      {rows.map((r) => (
        <div className="day-row" key={r.key}>
          <span className="day-time">{r.time}</span>
          <span className="day-label">
            {r.label}
            {r.who ? (
              <span className="day-who" style={{ display: 'block' }}>
                {r.who}
              </span>
            ) : null}
          </span>
          {r.flag !== undefined ? <span className="day-flag">{r.flag}</span> : <span />}
        </div>
      ))}
    </div>
  );
}
