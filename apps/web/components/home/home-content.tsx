import '@/app/styles/home.css';
import { Permission } from '@ocso/auth';
import { askOcsoCopy } from '@/components/shell/ask-ocso-copy';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api/errors';
import { loadHome, type HomeData } from '@/lib/api/home';
import { getInternalAgentCapabilities, internalAgentDeployment } from '@/lib/api/internal-agent';
import { initials } from '@/lib/format';
import { hasPermission, requireSession, type Session } from '@/lib/session';
import { AdminHome } from './admin-home';
import type { AskChip } from './ask-ocso-bar';
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

/**
 * Chips for the Home Ask OCSO bar, or null to hide it: the user may not use
 * Ask OCSO, no model profile is chosen yet, or the settings cannot be read.
 * Chips come from the capability catalog for this user's permissions.
 */
async function askChips(session: Session): Promise<AskChip[] | null> {
  if (!hasPermission(session, Permission.INTERNAL_AGENT_USE)) return null;
  try {
    const [{ configured }, capabilities] = await Promise.all([internalAgentDeployment(), getInternalAgentCapabilities().catch(() => null)]);
    if (!configured) return null;
    if (capabilities?.suggestions.length) return capabilities.suggestions.map((s) => ({ label: s.label, prompt: s.prompt }));
    return askOcsoCopy(session, initials(session.user.name)).suggestions.map((q) => ({ label: q, prompt: q }));
  } catch {
    return null;
  }
}

/** Role-aware Home (HOME contract): the API decides which single surface the caller gets. */
export async function HomeContent() {
  const session = await requireSession();
  const [home, ask] = await Promise.all([homeOrNull(), askChips(session)]);
  if (!home) {
    return (
      <EmptyState title="No home for this role">
        {session.roleLabel} accounts have no home surface. Use the navigation to reach the areas your role can open.
      </EmptyState>
    );
  }
  const parsed = Date.parse(home.generatedAt);
  const now = Number.isFinite(parsed) ? new Date(parsed) : new Date();
  switch (home.role) {
    case 'TECH':
      return <AdminHome session={session} home={home} ask={ask} now={now} />;
    case 'HEAD':
      return <LeadHome session={session} home={home} ask={ask} now={now} />;
    case 'SERVICE':
      return <ExecHome session={session} home={home} ask={ask} now={now} />;
  }
}
