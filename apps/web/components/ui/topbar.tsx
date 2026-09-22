import Link from 'next/link';
import type { ReactNode } from 'react';

export interface TopbarProps {
  /** Placeholder shown in the search affordance. */
  searchLabel?: string;
  searchHref?: string;
  /** Right-aligned controls (range chip, alerts, Ask OCSO). */
  children?: ReactNode;
}

/** Page top bar: search affordance, spacer, actions. */
export function Topbar({ searchLabel = 'Search', searchHref = '/search', children }: TopbarProps) {
  return (
    <div className="topbar" style={{ marginBottom: 18 }}>
      <Link className="topbar-search" href={searchHref}>
        <span>{searchLabel}</span>
        <span className="topbar-search-shortcut" aria-hidden="true">
          ⌘K
        </span>
      </Link>
      <span className="topbar-spacer" />
      {children}
    </div>
  );
}
