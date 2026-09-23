import { describe, expect, it } from 'vitest';
import { Permission, permissionsForRole } from '@ocso/auth';
import { AgentSchema } from '../../../components/agents/data/agent-schemas';
import { creatableTeams, handOffWarning, ownerChoices, ownerLabel, ownerProblem } from '../../../components/agents/lib/owners';

/** Owning teams (ADR-026): the form offers what the API accepts. */

const cards = { id: 'team-cards', name: 'Cards' };
const loans = { id: 'team-loans', name: 'Loans' };
const hardship = { id: 'team-hardship', name: 'Hardship' };
const all = [loans, cards, hardship];

describe('owner choices', () => {
  it('offers the Tech Admin every team, sorted, with current owners checked', () => {
    expect(ownerChoices('admin', all, [loans], [])).toEqual([
      { id: 'team-cards', name: 'Cards', checked: false, locked: false },
      { id: 'team-hardship', name: 'Hardship', checked: false, locked: false },
      { id: 'team-loans', name: 'Loans', checked: true, locked: false },
    ]);
  });

  it('offers a lead their own teams and shows other owners locked', () => {
    expect(ownerChoices('lead', all, [cards, loans], [cards.id, hardship.id])).toEqual([
      { id: 'team-cards', name: 'Cards', checked: true, locked: false },
      { id: 'team-hardship', name: 'Hardship', checked: false, locked: false },
      { id: 'team-loans', name: 'Loans', checked: true, locked: true },
    ]);
  });

  it('requires at least one owner and warns a lead who hands the agent off', () => {
    expect(ownerProblem([])).toBe('Choose at least one owning team.');
    expect(ownerProblem([cards.id])).toBeNull();
    expect(handOffWarning('lead', [loans.id], [cards.id])).toMatch(/lose access/);
    expect(handOffWarning('lead', [cards.id, loans.id], [cards.id])).toBeNull();
    expect(handOffWarning('admin', [loans.id], [])).toBeNull();
  });

  it('labels owners and lists the teams a lead may create agents for', () => {
    expect(ownerLabel([cards, loans])).toBe('Cards · Loans');
    expect(ownerLabel([])).toBe('no owning team');
    expect(creatableTeams(all, [loans.id, cards.id])).toEqual([cards, loans]);
    expect(creatableTeams(all, [])).toEqual([]);
  });
});

describe('ownership permissions', () => {
  it('lets only the Tech Admin reassign owners across teams; leads manage within theirs', () => {
    expect(permissionsForRole('PLATFORM_TECH_ADMIN')).toEqual(expect.arrayContaining([Permission.AGENTS_ASSIGN_OWNER, Permission.AGENTS_READ_ALL]));
    expect(permissionsForRole('CS_LEAD')).not.toContain(Permission.AGENTS_ASSIGN_OWNER);
    expect(permissionsForRole('CS_LEAD')).toEqual(expect.arrayContaining([Permission.AGENTS_MANAGE, Permission.CONVERSATIONS_READ_TEAM]));
    expect(permissionsForRole('CS_EXEC')).not.toContain(Permission.CONVERSATIONS_READ_TEAM);
  });

  it('requires the owning teams on agent responses', () => {
    const shape = AgentSchema.shape.teams;
    expect(shape.safeParse([{ id: 'x', name: 'Cards' }]).success).toBe(true);
    expect(shape.safeParse(undefined).success).toBe(false);
  });
});
