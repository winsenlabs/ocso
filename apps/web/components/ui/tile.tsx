import type { ReactNode } from 'react';

export interface TileProps {
  label: string;
  /** Omit (or pass null) when there is no data yet: renders "—" and says so. */
  value?: ReactNode;
  delta?: ReactNode;
  tone?: 'warn';
}

/** Metric tile (.tile). Never shows an invented zero: missing data reads "no data yet". */
export function Tile({ label, value, delta, tone }: TileProps) {
  const empty = value === undefined || value === null;
  const classes = ['tile', tone, empty ? 'nodata' : undefined].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div className="v">
        {empty ? <span aria-hidden="true">—</span> : value}
        {!empty && delta ? <span className="delta">{delta}</span> : null}
      </div>
      <div className="k">{label}</div>
      {empty ? <div className="nd">no data yet</div> : null}
    </div>
  );
}

/** Responsive tile row; `min` is the minimum tile width in px. */
export function Tiles({ min = 146, children }: { min?: number; children: ReactNode }) {
  return (
    <div className="tiles" style={{ gridTemplateColumns: `repeat(auto-fit,minmax(${min}px,1fr))` }}>
      {children}
    </div>
  );
}
