import type { ReactNode } from 'react';

/** A metric label whose formula shows on hover/focus (docs/archive/specs/11 §3: every number is explainable). */
export function Def({ definition, children }: { definition: string | null | undefined; children: ReactNode }) {
  if (!definition) return <>{children}</>;
  return (
    <span className="def" title={definition} tabIndex={0}>
      {children}
    </span>
  );
}

export interface DefinitionItem {
  label: string;
  definition: string;
}

/** Footnote listing the formula behind each number on the panel. */
export function Definitions({ items, summary = 'How these numbers are computed' }: { items: DefinitionItem[]; summary?: string }) {
  const unique = items.filter((item, i) => item.definition && items.findIndex((o) => o.label === item.label) === i);
  if (unique.length === 0) return null;
  return (
    <details className="defs">
      <summary>{summary}</summary>
      <dl>
        {unique.map((item) => (
          <div key={item.label} style={{ display: 'contents' }}>
            <dt>{item.label}</dt>
            <dd>{item.definition}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
