import { diffRows, type DiffRow } from './audit-meta';

const LABEL: Record<DiffRow['change'], string> = { changed: 'changed', added: 'set', removed: 'removed', same: 'unchanged', context: 'not in change' };

function Rows({ rows }: { rows: DiffRow[] }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.path} className={r.change === 'same' || r.change === 'context' ? 'r same' : 'r'} role="row" aria-label={`${r.path} ${LABEL[r.change]}`}>
          <span className="k" role="cell">
            {r.path}
          </span>
          <span className={r.before !== null && r.change !== 'same' && r.change !== 'context' ? 'v old' : 'v'} role="cell">
            {r.before ?? '—'}
          </span>
          <span className={r.after !== null && r.change !== 'same' ? 'v new' : 'v'} role="cell">
            {r.after ?? '—'}
          </span>
        </div>
      ))}
    </>
  );
}

/** Before/after of an audit entry, field by field; unchanged fields fold away. */
export function AuditDiff({ before, after }: { before: unknown; after: unknown }) {
  const rows = diffRows(before, after);
  if (rows.length === 0) return <span className="mono-sm">No before/after payload was recorded for this action.</span>;
  const changed = rows.filter((r) => r.change !== 'same' && r.change !== 'context');
  const rest = rows.filter((r) => r.change === 'same' || r.change === 'context');
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div className="diff" role="table" aria-label="Before and after">
        <div className="r h" role="row">
          <span role="columnheader">field</span>
          <span role="columnheader">before</span>
          <span role="columnheader">after</span>
        </div>
        {changed.length ? <Rows rows={changed} /> : null}
      </div>
      {changed.length === 0 ? <span className="mono-sm">no field changed</span> : null}
      {rest.length ? (
        <details>
          <summary className="mono-sm">
            {rest.length} field{rest.length === 1 ? '' : 's'} not changed by this action
          </summary>
          <div className="diff" role="table" aria-label="Unchanged fields" style={{ marginTop: 6 }}>
            <Rows rows={rest} />
          </div>
        </details>
      ) : null}
    </div>
  );
}
