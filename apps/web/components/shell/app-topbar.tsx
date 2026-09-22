import Link from 'next/link';
import type { ReactNode } from 'react';
import { Topbar } from '@/components/ui/topbar';
import { AskOcsoButton } from './ask-ocso-button';

/**
 * Standard page top bar: search, optional page controls, Alerts, Ask OCSO.
 * Static (no session read) so it is part of every page's instant shell;
 * every role has an alerts audience, and /alerts checks permissions itself.
 */
export function AppTopbar({ searchLabel = 'Search', children }: { searchLabel?: string; children?: ReactNode }) {
  return (
    <Topbar searchLabel={searchLabel}>
      {children}
      <Link className="topbar-btn" href="/alerts">
        Alerts
      </Link>
      <AskOcsoButton variant="topbar" />
    </Topbar>
  );
}
