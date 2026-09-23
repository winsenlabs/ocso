import { createTestDatabase, type TestDatabase } from '@ocso/db/testing';
import { modelProfiles, modelProviders, teamMembers, users, uuidv7 } from '@ocso/db';
import type { Principal } from '@ocso/auth';
import type { ApprovalAction } from '@ocso/domain';
import {
  AgentService,
  ApprovalDecisionService,
  ApprovalService,
  createApprovalRegistry,
  recordInstalledApproval,
  type ActorContext,
  type ApprovalRegistry,
  type ProposalDetail,
} from '../../src/index.js';
import { createTeam } from '../support/ownership.js';

/**
 * Maker–checker fixture: two teams; Cards has a Lead, two Heads and a Service
 * member; Loans has one Head; a Tech admin in no team. Maya (owned by Cards)
 * is a draft agent with a model profile and an active prompt, ready to go live.
 */
export interface ApprovalFixture {
  t: TestDatabase;
  team: { cards: string; loans: string };
  p: { lead: Principal; head: Principal; head2: Principal; headLoans: Principal; service: Principal; tech: Principal };
  profile: string;
  provider: string;
  maya: string;
  registry: ApprovalRegistry;
  published: Array<{ topic: string; payload: unknown }>;
  approvals: ApprovalService;
  decisions: ApprovalDecisionService;
  agents: AgentService;
  /** Submit a proposal as `maker` naming `checker`. */
  submit(maker: Principal, checker: Principal, target: { objectId?: string; action: ApprovalAction; payload?: Record<string, unknown>; objectKind?: string }): Promise<ProposalDetail>;
  /** Approve as `checker` with the hashes they are shown now. */
  approve(checker: Principal, id: string): Promise<ProposalDetail>;
  newAgent(name: string): Promise<string>;
}

let correlation = 0;
export const act = (principal: Principal): ActorContext => ({ principal, correlationId: `approvals-test-${++correlation}` });

export async function createApprovalFixture(): Promise<ApprovalFixture> {
  const t = await createTestDatabase();
  const team = { cards: await createTeam(t.db, uuidv7(), 'Cards'), loans: await createTeam(t.db, uuidv7(), 'Loans') };
  const person = (role: Principal['role'], name: string, teamIds: string[]): Principal => ({ userId: uuidv7(), role, displayName: name, teamIds, via: 'UI' });
  const p = {
    lead: person('LEAD', 'Lena Lead', [team.cards]),
    head: person('HEAD', 'Anjali Rao', [team.cards]),
    head2: person('HEAD', 'Priya Nair', [team.cards]),
    headLoans: person('HEAD', 'Rohan Kapoor', [team.loans]),
    service: person('SERVICE', 'Nikhil Menon', [team.cards]),
    tech: person('TECH', 'Tarun Shetty', []),
  };
  for (const who of Object.values(p)) {
    await t.db.insert(users).values({ id: who.userId, email: `${who.displayName.split(' ')[0]!.toLowerCase()}@bank.test`, name: who.displayName, role: who.role });
    for (const teamId of who.teamIds) await t.db.insert(teamMembers).values({ teamId, userId: who.userId });
  }
  const provider = uuidv7();
  const profile = uuidv7();
  await t.db.insert(modelProviders).values({ id: provider, kind: 'DEV_SCRIPTED', name: 'Scripted' });
  await t.db.insert(modelProfiles).values({ id: profile, name: 'support-fast', providerId: provider, model: 'scripted-1' });
  // Pre-existing platform configuration (grandfathered, like 0031): agents go live only on approved profiles.
  await recordInstalledApproval(t.db, { kind: 'model_profile', id: profile, title: 'support-fast' }, 'Test fixture: existing profile');
  const registry = createApprovalRegistry();
  const published: Array<{ topic: string; payload: unknown }> = [];
  const queue = { publish: async (topic: string, payload: unknown) => void published.push({ topic, payload }) };
  const approvals = new ApprovalService(t.db, registry, { queue });
  const decisions = new ApprovalDecisionService(t.db, registry, { queue });
  const agents = new AgentService(t.db);
  const newAgent = async (name: string) =>
    (await agents.create(act(p.lead), { name, purpose: 'support', conversationType: 'SUPPORT', description: '', modelProfileId: profile, teamIds: [team.cards] })).id;
  const maya = await newAgent('Maya');
  return {
    t,
    team,
    p,
    profile,
    provider,
    maya,
    registry,
    published,
    approvals,
    decisions,
    agents,
    newAgent,
    submit: (maker, checker, target) =>
      approvals.submit(act(maker), {
        objectKind: target.objectKind ?? 'agent',
        objectId: target.objectId ?? maya,
        action: target.action,
        checkerId: checker.userId,
        reason: 'Ready for customers',
        payload: target.payload,
      }),
    approve: async (checker, id) => {
      const shown = await approvals.get(checker, id);
      return decisions.decide(act(checker), id, { decision: 'APPROVE', reason: 'Looks right', contentHash: shown.contentHash, dependencyHash: shown.dependencyHash });
    },
  };
}
