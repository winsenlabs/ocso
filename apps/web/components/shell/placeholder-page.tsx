import type { ReactNode } from 'react';
import type { Permission } from '@ocso/auth';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHead } from '@/components/ui/page-head';
import { hasAnyPermission, requireSession } from '@/lib/session';
import { AppTopbar } from './app-topbar';
import { PageBody } from './page-body';

export interface PlaceholderPageProps {
  title: string;
  sub: string;
  /** Any of these permissions lets the user see the page; the API enforces the real check. */
  requires?: readonly Permission[];
  emptyTitle: string;
  /** What will appear here once the backing API exists. */
  children: ReactNode;
  searchLabel?: string;
  /** Real content shown above the empty state (may be an async server component). */
  before?: ReactNode;
}

/** A nav target whose API is still being built: page head plus an honest empty state. */
export function PlaceholderPage({ title, sub, requires, emptyTitle, children, searchLabel, before }: PlaceholderPageProps) {
  return (
    <>
      <AppTopbar {...(searchLabel ? { searchLabel } : {})} />
      <PageHead title={title} sub={sub} />
      <PageBody>
        <PlaceholderBody requires={requires} emptyTitle={emptyTitle} before={before}>
          {children}
        </PlaceholderBody>
      </PageBody>
    </>
  );
}

async function PlaceholderBody({
  requires,
  emptyTitle,
  before,
  children,
}: {
  requires: readonly Permission[] | undefined;
  emptyTitle: string;
  before: ReactNode;
  children: ReactNode;
}) {
  const session = await requireSession();
  if (requires && !hasAnyPermission(session, requires)) return <NotPermitted role={session.roleLabel} />;
  return (
    <>
      {before}
      <EmptyState title={emptyTitle}>{children}</EmptyState>
    </>
  );
}

export function NotPermitted({ role }: { role: string }) {
  return (
    <EmptyState title="Not available for your role">
      {role} accounts do not have access to this area. If you need it, ask a Platform Tech Admin to review your role.
    </EmptyState>
  );
}
