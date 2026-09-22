import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** Compact variant for rail cards and small panels. */
  size?: 'sm';
}

/** Dashed empty state (.empty): says what will appear here and why it is empty. */
export function EmptyState({ title, children, actions, size }: EmptyStateProps) {
  return (
    <div className={size ? `empty ${size}` : 'empty'}>
      <h3>{title}</h3>
      {children ? <p>{children}</p> : null}
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}
