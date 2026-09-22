import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { conversations, customers, queueTeams, queues, teamMembers, users, uuidv7, virtualAgents } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import { AgentService, EscalationRuleInput, EscalationRuleService, type ActorContext } from '../../src/index.js';
import { createTeam } from './ownership.js';

/**
 * Two teams, two CS Leads, one exec per team and a Tech Admin (ADR-026):
 * - maya:   owned by Cards only; default queue Cards; one escalation rule targets the Loans queue.
 * - arjun:  owned by Loans only; default queue Loans.
 * - shared: owned by Cards and Loans (the Tech Admin assigned Loans as a second owner).
 * - orphan: no owning team (what the migration leaves for agents without a default-queue team).
 * Conversations: c1 maya/no queue (AI), c2 maya routed to the Loans queue, c3 arjun in the Loans queue.
 */
export interface OwnershipFixture {
  t: TestDatabase;
  team: { cards: string; loans: string };
  queue: { cards: string; loans: string };
  p: { leadA: Principal; leadB: Principal; execA: Principal; execB: Principal; admin: Principal };
  agent: { maya: string; arjun: string; shared: string; orphan: string };
  conv: { c1: string; c2: string; c3: string };
  customer: { c1: string; c3: string };
  mayaRule: string;
}

export const actor = (principal: Principal): ActorContext => ({ principal, correlationId: 'ownership-test' });

export async function createOwnershipFixture(): Promise<OwnershipFixture> {
  const t = await createTestDatabase();
  const team = { cards: uuidv7(), loans: uuidv7() };
  await createTeam(t.db, team.cards, 'Cards');
  await createTeam(t.db, team.loans, 'Loans');
  const person = (role: Principal['role'], name: string, teamIds: string[]): Principal => ({ userId: uuidv7(), role, displayName: name, teamIds, via: 'UI' });
  const p = {
    leadA: person('CS_LEAD', 'Anjali Rao', [team.cards]),
    leadB: person('CS_LEAD', 'Rohan Kapoor', [team.loans]),
    execA: person('CS_EXEC', 'Nikhil Menon', [team.cards]),
    execB: person('CS_EXEC', 'Meera Pillai', [team.loans]),
    admin: person('PLATFORM_TECH_ADMIN', 'Tarun Shetty', []),
  };
  for (const who of Object.values(p)) {
    await t.db.insert(users).values({ id: who.userId, email: `${who.userId}@x.test`, name: who.displayName, role: who.role });
    for (const teamId of who.teamIds) await t.db.insert(teamMembers).values({ teamId, userId: who.userId });
  }
  const queue = { cards: uuidv7(), loans: uuidv7() };
  await t.db.insert(queues).values([
    { id: queue.cards, name: 'Cards & EMI' },
    { id: queue.loans, name: 'Loans desk' },
  ]);
  await t.db.insert(queueTeams).values([
    { queueId: queue.cards, teamId: team.cards },
    { queueId: queue.loans, teamId: team.loans },
  ]);

  const agents = new AgentService(t.db);
  const maya = (await agents.create(actor(p.leadA), { name: 'Maya', purpose: 'cards', conversationType: 'SUPPORT', description: '', defaultQueueId: queue.cards, teamIds: [team.cards] })).id;
  const arjun = (await agents.create(actor(p.leadB), { name: 'Arjun', purpose: 'loans', conversationType: 'SALES', description: '', defaultQueueId: queue.loans, teamIds: [team.loans] })).id;
  const shared = (await agents.create(actor(p.leadA), { name: 'Sana', purpose: 'shared desk', conversationType: 'SUPPORT', description: '', teamIds: [team.cards] })).id;
  await agents.setOwners(actor(p.admin), shared, [team.cards, team.loans]);
  const orphan = uuidv7();
  await t.db.insert(virtualAgents).values({ id: orphan, name: 'Legacy', slug: 'legacy', conversationType: 'CUSTOM' });
  const mayaRule = (await new EscalationRuleService(t.db).create(actor(p.leadA), maya, EscalationRuleInput.parse({ name: 'Loan questions', trigger: 'INTENT', targetQueueId: queue.loans }))).id;

  const customer = { c1: uuidv7(), c2: uuidv7(), c3: uuidv7() };
  await t.db.insert(customers).values([
    { id: customer.c1, displayName: 'Priya Deshmukh' },
    { id: customer.c2, displayName: 'Farida Sheikh' },
    { id: customer.c3, displayName: 'Nandini Shah' },
  ]);
  const conv = { c1: uuidv7(), c2: uuidv7(), c3: uuidv7() };
  const openedAt = new Date(Date.now() - 3_600_000);
  await t.db.insert(conversations).values([
    { id: conv.c1, customerId: customer.c1, agentId: maya, type: 'SUPPORT', controlState: 'AI_ACTIVE', openedAt, tags: ['vip'] },
    { id: conv.c2, customerId: customer.c2, agentId: maya, type: 'SUPPORT', controlState: 'WAITING_FOR_HUMAN', queueId: queue.loans, openedAt, tags: ['loan'] },
    { id: conv.c3, customerId: customer.c3, agentId: arjun, type: 'SALES', controlState: 'WAITING_FOR_HUMAN', queueId: queue.loans, openedAt },
  ]);
  return { t, team, queue, p, agent: { maya, arjun, shared, orphan }, conv, customer: { c1: customer.c1, c3: customer.c3 }, mayaRule };
}
