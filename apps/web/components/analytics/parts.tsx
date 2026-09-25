import Link from 'next/link';
import type { ReactNode } from 'react';
import { formatDateTime } from '@/lib/format';
import { WINDOW_OPTIONS } from './metrics';

/** Window selector (.seg of links, `?days=`) plus the exact window the numbers cover. */
export function WindowBar({ basePath, days, window, extra }: { basePath: string; days: number; window?: { from: string; to: string; timezone?: string } | undefined; extra?: ReactNode }) {
  return (
    <div className="ops-bar">
      <nav className="seg" aria-label="Time window">
        {WINDOW_OPTIONS.map((o) => (
          <Link key={o.days} href={`${basePath}?days=${o.days}`} className={o.days === days ? 'seg-opt active' : 'seg-opt'} aria-current={o.days === days ? 'page' : undefined} scroll={false}>
            {o.label}
          </Link>
        ))}
      </nav>
      {window ? (
        <span className="mono-sm">
          cohort: conversations opened {formatDateTime(window.from, window.timezone ?? 'UTC')} → {formatDateTime(window.to, window.timezone ?? 'UTC')}
          {window.timezone ? ` · ${window.timezone}` : ''}
        </span>
      ) : null}
      {extra ? <span className="ops-bar-extra">{extra}</span> : null}
    </div>
  );
}

/** Superscript link to a numbered metric definition at the foot of the page. */
export function Fn({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return (
    <a className="fn" href={`#def-${n}`} aria-label={`Definition ${n}`}>
      {n}
    </a>
  );
}

export interface MetricTileProps {
  label: string;
  /** null = no data in the window: renders "—" and says so, never a zero. */
  value: ReactNode | null;
  delta?: string | null;
  definition: string;
  note: number | undefined;
  tone?: 'warn' | undefined;
  caption?: ReactNode;
}

/** Metric tile (.tile) with its definition as tooltip and a footnote reference. */
export function MetricTile({ label, value, delta, definition, note, tone, caption }: MetricTileProps) {
  const empty = value === null;
  const classes = ['tile', tone, empty ? 'nodata' : undefined].filter(Boolean).join(' ');
  return (
    <div className={classes} title={definition}>
      <div className="v">
        {empty ? <span aria-hidden="true">—</span> : value}
        {!empty && delta ? (
          <span className="delta" title="vs the previous same-length window">
            {delta}
          </span>
        ) : null}
      </div>
      <div className="k">
        {label}
        <Fn n={note} />
      </div>
      {empty ? <div className="nd">no data in window</div> : caption ? <div className="nd">{caption}</div> : null}
    </div>
  );
}

/** Numbered metric definitions (docs/archive/specs/11 §3: every number is traceable to its formula). */
export function Definitions({ notes, title = 'How these numbers are computed' }: { notes: Array<{ n: number; text: string }>; title?: string }) {
  if (notes.length === 0) return null;
  return (
    <section className="ops-defs" aria-labelledby="ops-defs-title">
      <h2 id="ops-defs-title">{title}</h2>
      <ol>
        {notes.map((d) => (
          <li key={d.n} id={`def-${d.n}`} value={d.n}>
            {d.text}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Header cell text with a footnote reference. */
export function Th({ children, note }: { children: ReactNode; note?: number | undefined }) {
  return (
    <>
      {children}
      <Fn n={note} />
    </>
  );
}
