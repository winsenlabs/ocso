import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** grid-template-columns shared by head and rows (design: per-table widths). */
  template: string;
  label: string;
  /** Rendered instead of rows when `rows` is empty. */
  empty?: ReactNode;
  selectedKey?: string | null;
}

/** Dense data table (.dtable): mono uppercase head, hairline rows, grid columns. */
export function DataTable<T>({ columns, rows, rowKey, template, label, empty, selectedKey }: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <div className="dtable" role="table" aria-label={label}>
      <div className="dt-head" role="row" style={{ gridTemplateColumns: template }}>
        {columns.map((c) => (
          <span key={c.key} role="columnheader">
            {c.header}
          </span>
        ))}
      </div>
      {rows.map((row) => {
        const key = rowKey(row);
        return (
          <div
            key={key}
            className={key === selectedKey ? 'dt-row selected' : 'dt-row'}
            role="row"
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((c) => (
              <span key={c.key} role="cell">
                {c.cell(row)}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Primary cell: bold title with a mono caption underneath (design pattern). */
export function CellTitle({ title, caption }: { title: ReactNode; caption?: ReactNode }) {
  return (
    <>
      <b style={{ fontSize: 12.5 }}>{title}</b>
      {caption ? (
        <span className="mono-sm" style={{ display: 'block' }}>
          {caption}
        </span>
      ) : null}
    </>
  );
}
