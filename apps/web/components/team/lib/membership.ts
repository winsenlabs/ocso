import type { Role } from '@ocso/auth';

/**
 * Team membership rules (ADR-026), mirrored from TeamService / UserService so
 * the UI only offers what the API accepts. The API stays the enforcement
 * point and its errors are still shown. Client-safe.
 *
 * - Tech Admin (users.manage): every membership, via either endpoint.
 * - CS Lead (teams.manage): on teams they belong to, CS Execs and themselves.
 *   A lead cannot join a team they are not in, so leaving one is undone only
 *   by a Tech Admin.
 * - Team name/description: CS Leads, on teams they belong to.
 */

export interface MembershipViewer {
  id: string;
  /** users.manage (Tech Admin). */
  manageAll: boolean;
  /** teams.manage (CS Lead). */
  manageTeams: boolean;
  teamIds: readonly string[];
}

export interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  teamIds: readonly string[];
}

/** An agent (owning teams) or a queue (serving teams). */
export interface TeamBound {
  id: string;
  name: string;
  teamIds: readonly string[];
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/** The viewer may change at least some memberships of this team. */
export function managesTeam(viewer: MembershipViewer, teamId: string): boolean {
  return viewer.manageAll || (viewer.manageTeams && viewer.teamIds.includes(teamId));
}

/** Mirrors TeamService.assertCanChangeMembership. */
export function canChangeMembership(viewer: MembershipViewer, teamId: string, person: Pick<Person, 'id' | 'role'>): boolean {
  if (viewer.manageAll) return true;
  if (!viewer.manageTeams || !viewer.teamIds.includes(teamId)) return false;
  return person.id === viewer.id || person.role === 'CS_EXEC';
}

export function canEditTeamDetails(viewer: MembershipViewer, teamId: string): boolean {
  return viewer.manageTeams && viewer.teamIds.includes(teamId);
}

/** Active people the viewer may add to the team, matching `query` (name or email). */
export function eligibleMembers(viewer: MembershipViewer, teamId: string, people: readonly Person[], memberIds: readonly string[], query = ''): Person[] {
  const members = new Set(memberIds);
  const q = query.trim().toLowerCase();
  return people
    .filter((p) => p.status === 'ACTIVE' && !members.has(p.id) && canChangeMembership(viewer, teamId, p))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q))
    .sort(byName);
}

/** How the viewer may edit a person's teams from the People table (null: not at all). */
export type TeamEditMode = 'admin' | 'exec' | 'self';

export function teamEditMode(viewer: MembershipViewer, person: Pick<Person, 'id' | 'role'>): TeamEditMode | null {
  if (viewer.manageAll) return 'admin';
  if (!viewer.manageTeams || !viewer.teamIds.length) return null;
  if (person.id === viewer.id) return 'self';
  return person.role === 'CS_EXEC' ? 'exec' : null;
}

export interface TeamChoice {
  id: string;
  name: string;
  checked: boolean;
  /** Shown (the person is in it) but not changeable by the viewer. */
  locked: boolean;
}

/**
 * Checkbox rows for a person's teams. Admin: every team. Lead for a CS Exec:
 * the lead's teams, plus the exec's other teams locked. Lead for themselves:
 * only the teams they are in (they can leave, not join).
 */
export function teamChoices(mode: TeamEditMode, viewer: MembershipViewer, person: Pick<Person, 'teamIds'>, teams: ReadonlyArray<{ id: string; name: string }>): TeamChoice[] {
  const current = new Set(person.teamIds);
  const mine = new Set(viewer.teamIds);
  return teams
    .filter((t) => mode === 'admin' || (mode === 'self' ? current.has(t.id) : mine.has(t.id) || current.has(t.id)))
    .map((t) => ({ id: t.id, name: t.name, checked: current.has(t.id), locked: mode === 'exec' && !mine.has(t.id) }))
    .sort(byName);
}

export function teamDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((t) => !before.includes(t)), removed: before.filter((t) => !after.includes(t)) };
}

export interface RemovalEffect {
  name: string;
  role: Role;
  self: boolean;
  /** CS Lead: agents no remaining team of theirs owns (they stop managing them). */
  lostAgents: string[];
  /** Queues none of their remaining teams serve (routing and conversation scope). */
  lostQueues: string[];
  noTeamsLeft: boolean;
  /** Teams left without any CS Lead while they own agents. */
  leaderless: string[];
}

export interface RemovalInput {
  person: Pick<Person, 'id' | 'name' | 'role' | 'teamIds'>;
  viewerId: string;
  removed: readonly string[];
  added?: readonly string[];
  /** Agents visible to the viewer, with owning teams. */
  agents: readonly TeamBound[];
  queues: readonly TeamBound[];
  /** Everyone (for "who else leads this team"). */
  people: ReadonlyArray<Pick<Person, 'id' | 'role' | 'teamIds'>>;
  teams: ReadonlyArray<{ id: string; name: string }>;
}

const touches = (bound: TeamBound, ids: ReadonlySet<string>) => bound.teamIds.some((t) => ids.has(t));

/** What removing a person from teams changes for them (and for the teams). */
export function removalEffect({ person, viewerId, removed, added = [], agents, queues, people, teams }: RemovalInput): RemovalEffect {
  const gone = new Set(removed);
  const remaining = new Set([...person.teamIds.filter((t) => !gone.has(t)), ...added]);
  const lost = (bound: readonly TeamBound[]) => bound.filter((b) => touches(b, gone) && !touches(b, remaining)).sort(byName).map((b) => b.name);
  const isAdmin = person.role === 'PLATFORM_TECH_ADMIN';
  const lead = person.role === 'CS_LEAD';
  const leaderless = lead
    ? teams
        .filter((t) => gone.has(t.id) && agents.some((a) => a.teamIds.includes(t.id)))
        .filter((t) => !people.some((p) => p.id !== person.id && p.role === 'CS_LEAD' && p.teamIds.includes(t.id)))
        .map((t) => t.name)
    : [];
  return {
    name: person.name,
    role: person.role,
    self: person.id === viewerId,
    lostAgents: lead ? lost(agents) : [],
    lostQueues: isAdmin ? [] : lost(queues),
    noTeamsLeft: remaining.size === 0,
    leaderless,
  };
}

const list = (names: readonly string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Plain-language consequences for the confirm dialog, and whether they deserve a warning. */
export function describeRemoval(e: RemovalEffect): { warn: boolean; lines: string[] } {
  if (e.role === 'PLATFORM_TECH_ADMIN') return { warn: false, lines: ['Tech Admins read every agent whatever their teams: their access does not change.'] };
  const lines: string[] = [];
  const who = e.self ? 'You' : e.name;
  if (e.lostAgents.length) {
    lines.push(e.self ? `You will lose access to ${list(e.lostAgents)}: none of your remaining teams owns ${e.lostAgents.length === 1 ? 'it' : 'them'}.` : `${e.name} will no longer manage ${list(e.lostAgents)}: no other team of theirs owns ${e.lostAgents.length === 1 ? 'it' : 'them'}.`);
  }
  if (e.lostQueues.length) lines.push(`${who} will no longer get work from, or see conversations in, ${list(e.lostQueues)}.`);
  if (e.noTeamsLeft) lines.push(e.self ? 'This is your last team: you will manage no agents until a Platform Tech Admin adds you to one.' : `${e.name} will be in no team${e.role === 'CS_LEAD' ? ' and will manage no agents' : ': no queue will route work to them'}.`);
  for (const team of e.leaderless) lines.push(`${team} will have no CS Lead left to manage its agents.`);
  if (e.self && e.role === 'CS_LEAD') lines.push('Only a Platform Tech Admin can add you back.');
  if (!lines.length) lines.push(`${e.self ? 'Your' : `${e.name}’s`} access to agents and queues does not change.`);
  return { warn: e.lostAgents.length > 0 || e.leaderless.length > 0 || (e.self && e.noTeamsLeft), lines };
}

/** An agent as the team views show it. */
export interface AgentRef extends TeamBound {
  status: 'DRAFT' | 'LIVE' | 'PAUSED';
}

/** Everything the membership controls need, loaded once for the Team page. */
export interface TeamScope {
  viewer: MembershipViewer;
  people: Person[];
  teams: Array<{ id: string; name: string }>;
  /** Agents visible to the viewer; null when they could not be read. */
  agents: AgentRef[] | null;
  queues: TeamBound[] | null;
  /** agents.read_all (Tech Admin); otherwise only agents of the viewer's teams are visible. */
  allAgentsVisible: boolean;
}

/** Consequences of removing `person` from `removed` (and adding `added`), with the page's scope. */
export function removalFor(scope: TeamScope, person: RemovalInput['person'], removed: readonly string[], added: readonly string[] = []): { warn: boolean; lines: string[] } {
  const result = describeRemoval(
    removalEffect({ person, viewerId: scope.viewer.id, removed, added, agents: scope.agents ?? [], queues: scope.queues ?? [], people: scope.people, teams: scope.teams }),
  );
  if ((scope.agents && scope.queues) || person.role === 'PLATFORM_TECH_ADMIN') return result;
  return { warn: true, lines: [...result.lines.filter((l) => !l.endsWith('does not change.')), 'Agents and queues could not be loaded, so the effect on access is unknown.'] };
}
