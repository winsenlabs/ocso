import Link from 'next/link';
import type { CSSProperties } from 'react';
import type { MiniTableData, ObjectLink } from './types';

/** "3 steps · queue status · list conversations · 1.6 s" (design/05 `.tool`). */
export function StepsLine({ steps, durationMs, working }: { steps: string[]; durationMs: number | null; working: boolean }) {
  if (!steps.length && !working) return null;
  const parts = [steps.length ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : 'checking', ...steps];
  if (!working && durationMs !== null) parts.push(`${(durationMs / 1000).toFixed(1)} s`);
  return (
    <div className="ia-steps">
      {parts.join(' · ')}
      {working ? '…' : ''}
    </div>
  );
}

const DOT: Record<string, string> = { ok: 'okdot', warn: 'okdot w', danger: 'okdot d' };

/** In-app links only: same-origin paths, never a protocol or another host. */
export function safeHref(href: string): string | null {
  return href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\') ? href : null;
}

/** Cards linking to the OCSO pages a tool answer refers to (design/05 `.ccard`). */
export function LinkCards({ links }: { links: ObjectLink[] }) {
  return (
    <>
      {links.map((link, i) => {
        const href = safeHref(link.href);
        const body = (
          <>
            <span className={link.status ? (DOT[link.status] ?? 'okdot m') : 'okdot m'} aria-hidden="true" />
            <span>
              <span className="ct">{link.label}</span>
              {link.detail ? <span className="cs2">{link.detail}</span> : null}
            </span>
            {href ? <span className="mono-sm">open →</span> : <span />}
          </>
        );
        return href ? (
          <Link key={`${link.href}-${i}`} className="ccard" href={href}>
            {body}
          </Link>
        ) : (
          <div key={`${link.href}-${i}`} className="ccard">
            {body}
          </div>
        );
      })}
    </>
  );
}

const MAX_ROWS = 20;

/** Compact table from a tool answer (design/05 `.minitable`); first column is the label. */
export function MiniTable({ table }: { table: MiniTableData }) {
  if (!table.columns.length) return null;
  const extra = table.columns.length - 1;
  const style = { '--ia-cols': `minmax(0,1fr)${extra > 0 ? ` repeat(${extra}, minmax(54px, auto))` : ''}` } as CSSProperties;
  const rows = table.rows.slice(0, MAX_ROWS);
  return (
    <div className="minitable ia-table" role="table" aria-label={table.columns[0]} style={style}>
      <div className="r h" role="row">
        {table.columns.map((c, i) => (
          <span key={i} role="columnheader" className={i > 0 ? 'n' : undefined}>
            {c}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div className="r" role="row">
          <span role="cell" className="ia-muted">
            No rows
          </span>
        </div>
      ) : (
        rows.map((row, r) => (
          <div className="r" role="row" key={r}>
            {table.columns.map((_, i) => (
              <span key={i} role="cell" className={i > 0 ? 'n' : undefined}>
                {row[i] ?? '—'}
              </span>
            ))}
          </div>
        ))
      )}
      {table.rows.length > MAX_ROWS ? <div className="r ia-muted">{table.rows.length - MAX_ROWS} more rows not shown</div> : null}
    </div>
  );
}

/** The user's role does not cover what was asked (docs/12 §3): say so, never work around it. */
export function DeniedNotice({ message }: { message: string }) {
  return (
    <div className="denied" role="note">
      <b style={{ color: 'var(--ink-2)' }}>{message}</b> Ask OCSO acts with exactly your permissions, so it did not try another way. Someone whose role covers
      this can answer it.
    </div>
  );
}
