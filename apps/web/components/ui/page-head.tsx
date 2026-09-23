import type { ReactNode } from 'react';

export interface PageHeadProps {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}

/** Page title + subtitle, with actions aligned right when present. */
export function PageHead({ title, sub, actions }: PageHeadProps) {
  const head = (
    <div className="page-head">
      <h1>{title}</h1>
      {sub ? <p className="page-sub">{sub}</p> : null}
    </div>
  );
  if (!actions) return head;
  return (
    <div className="page-head-row">
      {head}
      <div className="page-head-actions">{actions}</div>
    </div>
  );
}
