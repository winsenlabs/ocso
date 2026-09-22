import { describe, expect, it } from 'vitest';
import {
  canChangeMembership,
  canEditTeamDetails,
  describeRemoval,
  eligibleMembers,
  managesTeam,
  removalEffect,
  removalFor,
  teamChoices,
  teamDiff,
  teamEditMode,
  type MembershipViewer,
  type Person,
  type TeamScope,
} from '../../../components/team/lib/membership';

const TEAMS = [
  { id: 'cards', name: 'Cards' },
  { id: 'loans', name: 'Loans' },
  { id: 'sales', name: 'Sales' },
];
const person = (id: string, role: Person['role'], teamIds: string[], status: Person['status'] = 'ACTIVE'): Person => ({ id, name: id[0]!.toUpperCase() + id.slice(1), email: `${id}@bank.test`, role, status, teamIds });
const PEOPLE = [
  person('tara', 'PLATFORM_TECH_ADMIN', []),
  person('leo', 'CS_LEAD', ['cards', 'loans']),
  person('lou', 'CS_LEAD', ['loans']),
  person('esha', 'CS_EXEC', ['cards']),
  person('eli', 'CS_EXEC', []),
  person('gone', 'CS_EXEC', [], 'DISABLED'),
];
const ADMIN: MembershipViewer = { id: 'tara', manageAll: true, manageTeams: false, teamIds: [] };
const LEAD: MembershipViewer = { id: 'leo', manageAll: false, manageTeams: true, teamIds: ['cards', 'loans'] };
const AGENTS = [
  { id: 'a1', name: 'Maya', teamIds: ['cards'] },
  { id: 'a2', name: 'Riya', teamIds: ['cards', 'loans'] },
  { id: 'a3', name: 'Arjun', teamIds: ['loans'] },
];
const QUEUES = [
  { id: 'q1', name: 'Cards T2', teamIds: ['cards'] },
  { id: 'q2', name: 'Shared', teamIds: ['cards', 'sales'] },
];
const at = (id: string) => PEOPLE.find((p) => p.id === id)!;

describe('who may change a membership (mirrors TeamService)', () => {
  it('lets the Tech Admin change anyone on any team', () => {
    expect(canChangeMembership(ADMIN, 'sales', at('lou'))).toBe(true);
    expect(managesTeam(ADMIN, 'sales')).toBe(true);
  });

  it('lets a CS Lead change CS Execs and themselves, only on their own teams', () => {
    expect(canChangeMembership(LEAD, 'cards', at('esha'))).toBe(true);
    expect(canChangeMembership(LEAD, 'cards', at('leo'))).toBe(true);
    expect(canChangeMembership(LEAD, 'loans', at('lou'))).toBe(false);
    expect(canChangeMembership(LEAD, 'cards', at('tara'))).toBe(false);
    expect(canChangeMembership(LEAD, 'sales', at('eli'))).toBe(false);
    expect(managesTeam(LEAD, 'sales')).toBe(false);
  });

  it('renaming is for CS Leads of the team (the Tech Admin lacks teams.manage)', () => {
    expect(canEditTeamDetails(LEAD, 'cards')).toBe(true);
    expect(canEditTeamDetails(LEAD, 'sales')).toBe(false);
    expect(canEditTeamDetails(ADMIN, 'cards')).toBe(false);
  });
});

describe('add-member picker', () => {
  it('offers a lead active CS Execs not yet in the team, filtered by name or email', () => {
    expect(eligibleMembers(LEAD, 'cards', PEOPLE, ['leo', 'esha']).map((p) => p.id)).toEqual(['eli']);
    expect(eligibleMembers(LEAD, 'loans', PEOPLE, ['leo', 'lou']).map((p) => p.id)).toEqual(['eli', 'esha']);
    expect(eligibleMembers(LEAD, 'loans', PEOPLE, ['leo', 'lou'], 'ESHA@').map((p) => p.id)).toEqual(['esha']);
    expect(eligibleMembers(LEAD, 'sales', PEOPLE, [])).toEqual([]);
  });

  it('offers the Tech Admin every active person, never disabled users', () => {
    expect(eligibleMembers(ADMIN, 'sales', PEOPLE, []).map((p) => p.id)).toEqual(['eli', 'esha', 'leo', 'lou', 'tara']);
  });
});

describe('editing teams from the People table', () => {
  it('picks the mode from the viewer and the person', () => {
    expect(teamEditMode(ADMIN, at('lou'))).toBe('admin');
    expect(teamEditMode(LEAD, at('esha'))).toBe('exec');
    expect(teamEditMode(LEAD, at('leo'))).toBe('self');
    expect(teamEditMode(LEAD, at('lou'))).toBeNull();
    expect(teamEditMode({ ...LEAD, teamIds: [] }, at('esha'))).toBeNull();
  });

  it('locks an exec’s foreign teams for a lead, and lets a lead only leave their own', () => {
    const exec = { teamIds: ['cards', 'sales'] };
    expect(teamChoices('exec', LEAD, exec, TEAMS)).toEqual([
      { id: 'cards', name: 'Cards', checked: true, locked: false },
      { id: 'loans', name: 'Loans', checked: false, locked: false },
      { id: 'sales', name: 'Sales', checked: true, locked: true },
    ]);
    expect(teamChoices('self', LEAD, at('leo'), TEAMS).map((c) => [c.id, c.checked, c.locked])).toEqual([
      ['cards', true, false],
      ['loans', true, false],
    ]);
    expect(teamChoices('admin', ADMIN, at('lou'), TEAMS).every((c) => !c.locked)).toBe(true);
    expect(teamDiff(['cards', 'loans'], ['loans', 'sales'])).toEqual({ added: ['sales'], removed: ['cards'] });
  });
});

describe('what a removal changes', () => {
  const base = { viewerId: 'tara', agents: AGENTS, queues: QUEUES, people: PEOPLE, teams: TEAMS };

  it('names the agents a lead stops managing when no remaining team owns them', () => {
    const e = removalEffect({ ...base, person: at('leo'), removed: ['cards'] });
    expect(e.lostAgents).toEqual(['Maya']); // Riya is still owned by Loans
    expect(e.lostQueues).toEqual(['Cards T2', 'Shared']);
    expect(e.noTeamsLeft).toBe(false);
    expect(e.leaderless).toEqual(['Cards']);
    const text = describeRemoval(e);
    expect(text.warn).toBe(true);
    expect(text.lines[0]).toBe('Leo will no longer manage Maya: no other team of theirs owns it.');
    expect(text.lines).toContain('Cards will have no CS Lead left to manage its agents.');
  });

  it('warns a lead leaving their last agent-owning team that only a Tech Admin can undo it', () => {
    const lou = at('lou');
    const { warn, lines } = describeRemoval(removalEffect({ ...base, viewerId: 'lou', person: lou, removed: ['loans'] }));
    expect(warn).toBe(true);
    expect(lines).toEqual([
      'You will lose access to Arjun and Riya: none of your remaining teams owns them.',
      'This is your last team: you will manage no agents until a Platform Tech Admin adds you to one.',
      'Only a Platform Tech Admin can add you back.',
    ]);
  });

  it('counts teams added in the same change (a move keeps shared agents)', () => {
    const e = removalEffect({ ...base, person: at('lou'), removed: ['loans'], added: ['cards'] });
    expect(e.lostAgents).toEqual(['Arjun']);
    expect(e.noTeamsLeft).toBe(false);
  });

  it('describes queues for a CS Exec, and no change for a Tech Admin', () => {
    const exec = describeRemoval(removalEffect({ ...base, person: at('esha'), removed: ['cards'] }));
    expect(exec.warn).toBe(false);
    expect(exec.lines).toEqual(['Esha will no longer get work from, or see conversations in, Cards T2 and Shared.', 'Esha will be in no team: no queue will route work to them.']);
    const admin = describeRemoval(removalEffect({ ...base, person: { ...at('tara'), teamIds: ['cards'] }, removed: ['cards'] }));
    expect(admin).toEqual({ warn: false, lines: ['Tech Admins read every agent whatever their teams: their access does not change.'] });
  });

  it('says so when nothing changes, and when agents could not be loaded', () => {
    const shared = describeRemoval(removalEffect({ ...base, person: { ...at('esha'), teamIds: ['cards', 'sales'] }, removed: ['sales'] }));
    expect(shared).toEqual({ warn: false, lines: ['Esha’s access to agents and queues does not change.'] });
    const scope: TeamScope = { viewer: ADMIN, people: PEOPLE, teams: TEAMS, agents: null, queues: QUEUES, allAgentsVisible: true };
    const unknown = removalFor(scope, at('leo'), ['cards']);
    expect(unknown.warn).toBe(true);
    expect(unknown.lines.at(-1)).toBe('Agents and queues could not be loaded, so the effect on access is unknown.');
  });
});
