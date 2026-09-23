import type { ReactNode } from 'react';

export interface Metric {
  label: string;
  value: ReactNode;
}

/** Metric matrix (.mtx): big tabular numbers with mono labels, N columns. */
export function MetricMatrix({ metrics, columns = 2 }: { metrics: Metric[]; columns?: number }) {
  return (
    <div className="mtx" style={{ gridTemplateColumns: `repeat(${columns},minmax(0,1fr))` }}>
      {metrics.map((m) => (
        <div key={m.label}>
          <span className="n">{m.value}</span>
          <span className="l">{m.label}</span>
        </div>
      ))}
    </div>
  );
}
