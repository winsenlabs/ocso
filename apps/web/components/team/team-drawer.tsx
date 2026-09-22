import Link from 'next/link';
import { RoutedDrawer } from '@/components/quality/routed-drawer';
import { EmptyState } from '@/components/ui/empty-state';
import { StatusChip } from '@/components/ui/status-chip';
import { ApiError } from '@/lib/api/errors';
import { getTeam, type TeamDetail } from '@/lib/api/teams';
import { formatDateTime } from '@/lib/format';
import { AddMember } from './add-member';
import { canEditTeamDetails, managesTeam, type TeamScope } from './lib/membership';
import { TeamDetailsForm } from './team-details-form';
import { TeamMembers } from './team-members';

const AGENT_TONE = { LIVE: 'good', PAUSED: 'warn', DRAFT: 'accent' } as const;

/** GET /v1/teams/:id; a deleted or unknown team becomes an explanation, not an error page. */
export async function loadTeamDetail(id: string): Promise<TeamDetail | null> {
  try {
    return await getTeam(id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.isForbidden)) return null;
    throw err;
  }
}

/** Team drawer (`/team?team=…`): members, owning agents, queues served, and the membership actions the viewer may take. */
export function TeamDrawer({ team, scope, timeZone }: { team: TeamDetail | null; scope: TeamScope; timeZone: string }) {
  if (!team) {
    return (
      <RoutedDrawer title="Team" sub="not available" closeHref="/team">
        <EmptyState title="Team not available">This team does not exist any more.</EmptyState>
      </RoutedDrawer>
    );
  }
  const agents = (scope.agents ?? []).filter((a) => a.teamIds.includes(team.id));
  const queues = (scope.queues ?? []).filter((q) => q.teamIds.includes(team.id));
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const members = team.members.map((m) => ({ ...m, addedLabel: `added ${formatDateTime(m.addedAt, timeZone)}` }));
  const isMember = scope.viewer.teamIds.includes(team.id);

  return (
    <RoutedDrawer title={team.name} sub={`${plural(team.memberCount, 'member')} · ${plural(agents.length, 'agent')} · ${plural(queues.length, 'queue')}`} closeHref="/team">
      <section className="tm-sec tm-panel" aria-label="Team details">
        {team.description ? <p className="tm-desc">{team.description}</p> : null}
        <span className="mono-sm">created {formatDateTime(team.createdAt, timeZone)}{isMember ? ' · you are a member' : ''}</span>
        {canEditTeamDetails(scope.viewer, team.id) ? <TeamDetailsForm id={team.id} name={team.name} description={team.description} /> : null}
      </section>

      <section className="tm-sec" aria-label="Members">
        <h3 className="grp">members · {team.memberCount}</h3>
        <TeamMembers teamId={team.id} teamName={team.name} members={members} />
        {managesTeam(scope.viewer, team.id) ? (
          <AddMember teamId={team.id} teamName={team.name} memberIds={team.members.map((m) => m.userId)} />
        ) : (
          <p className="mono-sm">{scope.viewer.manageTeams ? 'Only members of this team change its memberships. A Platform Tech Admin can add you.' : 'You cannot change memberships.'}</p>
        )}
      </section>

      <section className="tm-sec" aria-label="Owning agents">
        <h3 className="grp">owning agents · {agents.length}</h3>
        {scope.agents === null ? (
          <p className="mono-sm">Agents could not be loaded.</p>
        ) : agents.length ? (
          <ul className="tm-refs">
            {agents.map((a) => (
              <li key={a.id}>
                <Link href={`/agents/${a.id}`}>{a.name}</Link>
                <StatusChip tone={AGENT_TONE[a.status]}>{a.status.toLowerCase()}</StatusChip>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mono-sm">{scope.allAgentsVisible || isMember ? 'This team owns no agents. Its CS Leads manage the agents it owns.' : 'No agents you can see. Agents of teams you are not in are hidden.'}</p>
        )}
        {agents.length && !scope.allAgentsVisible && !isMember ? <p className="mono-sm">Only agents shared with your teams are shown.</p> : null}
      </section>

      <section className="tm-sec" aria-label="Queues served">
        <h3 className="grp">queues served · {queues.length}</h3>
        {scope.queues === null ? (
          <p className="mono-sm">Queues could not be loaded.</p>
        ) : queues.length ? (
          <ul className="tm-refs">
            {queues.map((q) => (
              <li key={q.id}>{q.name}</li>
            ))}
          </ul>
        ) : (
          <p className="mono-sm">No queue routes work to this team yet. Queues choose their teams on the Queues page.</p>
        )}
      </section>
    </RoutedDrawer>
  );
}
