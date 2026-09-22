import type { ReactNode } from 'react';

/** A titled block on /_design; `row` lays items out inline with wrapping. */
export function PreviewSection({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 34 }} aria-label={title}>
      <div className="sec-head">
        <h2>{title}</h2>
        {note ? <span className="desc">{note}</span> : null}
      </div>
      <div style={{ display: 'grid', gap: 14 }}>{children}</div>
    </section>
  );
}

export function Row({ children, gap = 8 }: { children: ReactNode; gap?: number }) {
  return <div style={{ display: 'flex', gap, flexWrap: 'wrap', alignItems: 'center' }}>{children}</div>;
}

/** Mono caption naming the state being shown. */
export function Caption({ children }: { children: ReactNode }) {
  return <span className="mono-sm">{children}</span>;
}
