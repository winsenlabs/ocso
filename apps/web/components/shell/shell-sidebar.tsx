import { Permission } from '@ocso/auth';
import { listTeams, teamNames, type Team } from '@/lib/api/teams';
import { initials } from '@/lib/format';
import { buildNav } from '@/lib/nav';
import { requireSession, type Session } from '@/lib/session';
import { AppSidebar } from './app-sidebar';
import { askOcsoCopy } from './ask-ocso-copy';
import { AskOcsoDrawerHost } from './ask-ocso-context';
import { LogoutButton } from './logout-button';
import { ThemeToggle } from './theme-toggle';

/**
 * Session-dependent chrome: loads the user (GET /v1/auth/me, redirecting to
 * /login when invalid), builds the permission-derived nav and mounts the Ask
 * OCSO drawer with role-aware copy. Streams behind the layout's Suspense
 * boundary, beside — never around — the page, so pages don't wait on it.
 */
export async function ShellSidebar() {
  const [session, teams] = await Promise.all([requireSession(), listTeams().catch(() => null)]);
  const { user } = session;
  const userInitials = initials(user.name);

  return (
    <>
      <AppSidebar
        nav={buildNav(session.permissions)}
        region={user.deployment.region}
        scope={{ org: user.deployment.orgName, label: user.deployment.label, path: scopePath(session, teams) }}
        user={{ initials: userInitials, name: user.name, roleLabel: session.roleLabel }}
        footerAction={
          <>
            <ThemeToggle />
            <LogoutButton />
          </>
        }
      />
      <AskOcsoDrawerHost copy={askOcsoCopy(session, userInitials)} />
    </>
  );
}

/** What the user's work is scoped to: their teams, or the whole deployment. */
function scopePath(session: Session, teams: Team[] | null): string {
  const names = teams ? teamNames(teams, session.user.teamIds) : [];
  if (names.length) return names.join(' · ');
  if (session.permissions.has(Permission.SYSTEM_READ)) return 'Platform · whole deployment';
  if (session.permissions.has(Permission.CONVERSATIONS_READ_ALL)) return 'All teams';
  return 'No team assigned';
}
