import { Permission } from '@ocso/auth';
import { EmptyState } from '@/components/ui/empty-state';
import { listAlerts } from '@/lib/api/alerts';
import { ApiError } from '@/lib/api/errors';
import { loadHome, type HomeData } from '@/lib/api/home';
import { hasPermission, requireSession } from '@/lib/session';
import { AdminHome } from './admin-home';
import { ExecHome } from './exec-home';
import { LeadHome } from './lead-home';

/** The role surface from GET /v1/home, or null when the API grants this user none (403). */
async function homeOrNull(): Promise<HomeData | null> {
  try {
    return await loadHome();
  } catch (err) {
    if (err instanceof ApiError && err.isForbidden) return null;
    throw err;
  }
}

/** Role-aware home (design/06): the API decides which single surface the caller gets. */
export async function HomeContent() {
  const session = await requireSession();
  const home = await homeOrNull();
  if (!home) {
    return (
      <EmptyState title="No home for this role">
        {session.roleLabel} accounts have no home surface. Use the navigation to reach the areas your role can open.
      </EmptyState>
    );
  }
  switch (home.role) {
    case 'PLATFORM_TECH_ADMIN':
      return <AdminHome session={session} data={home.admin} />;
    case 'CS_LEAD': {
      const alerts = hasPermission(session, Permission.ALERTS_BUSINESS_READ)
        ? await listAlerts({ status: 'UNRESOLVED', kind: 'BUSINESS', limit: 3 }).then((p) => p.items, () => null)
        : null;
      return <LeadHome session={session} data={home.lead} alerts={alerts} />;
    }
    case 'CS_EXEC':
      return <ExecHome session={session} data={home.exec} />;
  }
}
