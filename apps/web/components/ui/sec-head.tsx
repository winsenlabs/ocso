import type { CSSProperties, ReactNode } from 'react';

export interface SecHeadProps {
  title: ReactNode;
  /** Mono count caption, e.g. "4 waiting". */
  count?: ReactNode;
  desc?: ReactNode;
  actions?: ReactNode;
  id?: string;
  style?: CSSProperties;
}

/** Section heading row: h2, count, description, right-aligned actions. */
export function SecHead({ title, count, desc, actions, id, style }: SecHeadProps) {
  return (
    <div className="sec-head" style={style}>
      <h2 id={id}>{title}</h2>
      {count !== undefined && count !== null ? <span className="count">{count}</span> : null}
      {desc ? <span className="desc">{desc}</span> : null}
      {actions ? <div className="sec-head-actions">{actions}</div> : null}
    </div>
  );
}
