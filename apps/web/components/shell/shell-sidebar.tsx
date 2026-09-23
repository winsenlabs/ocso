import { initials } from '@/lib/format';
import { buildNav } from '@/lib/nav';
import { requireSession } from '@/lib/session';
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
  const session = await requireSession();
  const { user } = session;
  const userInitials = initials(user.name);

  return (
    <>
      <AppSidebar
        nav={buildNav(session.permissions)}
        region={user.deployment.region}
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
