import Link from 'next/link';
import { Suspense, type ReactNode } from 'react';
import { AlertsBadge } from '@/components/alerts/alerts-badge';
import { Topbar } from '@/components/ui/topbar';
import { AskOcsoButton } from './ask-ocso-button';

/**
 * Standard page top bar: search, optional page controls, Alerts, Ask OCSO.
 * Static (no session read) so it is part of every page's instant shell;
 * every role has an alerts audience, and /alerts checks permissions itself.
 * The unresolved-alert badge streams in behind its own Suspense.
 */
export function AppTopbar({ searchLabel = 'Search', children }: { searchLabel?: string; children?: ReactNode }) {
  return (
    <Topbar searchLabel={searchLabel}>
      {children}
      <Link className="topbar-btn" href="/alerts">
        Alerts
        <Suspense fallback={null}>
          <AlertsBadge />
        </Suspense>
      </Link>
      <AskOcsoButton variant="topbar" />
    </Topbar>
  );
}
