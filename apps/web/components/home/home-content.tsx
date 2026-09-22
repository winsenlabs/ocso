import { Permission } from '@ocso/auth';
import { listTeams, teamNames } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { homeVariant } from '@/lib/nav';
import { hasPermission, requireSession } from '@/lib/session';
import { AdminHome } from './admin-home';
import { ExecHome } from './exec-home';
import { LeadHome } from './lead-home';

/** Picks the role home (design/06) and gathers the real deployment facts for its strip. */
export async function HomeContent() {
  const session = await requireSession();
  const variant = homeVariant(session.permissions);
  const [teams, users] = await Promise.all([
    listTeams().catch(() => null),
    hasPermission(session, Permission.USERS_READ) ? listUsers().catch(() => null) : Promise.resolve(null),
  ]);
  const { deployment } = session.user;

  if (variant === 'exec') {
    const names = teams ? teamNames(teams, session.user.teamIds) : [];
    return <ExecHome session={session} teamLabel={names.length ? names.join(', ') : null} />;
  }
  const people = [users ? plural(users.length, 'user') : null, teams ? plural(teams.length, 'team') : null].filter((s): s is string => s !== null);
  if (variant === 'lead') {
    return <LeadHome session={session} facts={[`${deployment.orgName} · ${deployment.label}`, ...people]} />;
  }
  return <AdminHome session={session} facts={['Single-tenant', deployment.region ?? 'region not set', deployment.label, ...people]} />;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
