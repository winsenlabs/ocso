import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { SETTINGS_OBJECT_ID, SetupService, type ActorContext } from '@ocso/application';
import { teams, users } from '@ocso/db';
import { actorFor, type SeedContext } from '../context.js';
import { approveAs, approveProposal, finishDeferred, unfinishedProposal } from './agents.js';
import { ORG, TEAMS, USERS, type DemoUser, type LeadKey, type TeamKey } from '../data/organization.js';

export interface SeededPeople {
  admin: ActorContext;
  lead: ActorContext;
  /** Both Leads, with their team memberships (agents are managed through them). */
  leads: Record<LeadKey, ActorContext>;
  ids: Record<DemoUser['key'], string>;
  teamIds: Record<TeamKey, string>;
}

const adminUser = USERS.find((u) => u.key === 'admin')!;
const leadUser = USERS.find((u) => u.key === 'lead')!;
const salesLeadUser = USERS.find((u) => u.key === 'lead2')!;

async function userIdByEmail(ctx: SeedContext, email: string): Promise<string | null> {
  const [row] = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${email})`);
  return row?.id ?? null;
}

/**
 * First Tech admin through the real first-run setup (ADR-010). The one-time
 * token is generated in-process and never leaves it. Refuses to touch a
 * deployment that a person already set up.
 */
async function ensureAdmin(ctx: SeedContext): Promise<string> {
  const existing = await userIdByEmail(ctx, adminUser.email);
  if (existing) return existing;
  const token = randomBytes(24).toString('base64url');
  const setup = new SetupService(ctx.db, token);
  if (!(await setup.isSetupRequired())) {
    throw new Error('This deployment was already set up by a person; the demo seed only runs on a fresh database (docker compose down -v to start over).');
  }
  const { userId } = await setup.complete(
    { setupToken: token, orgName: ORG.orgName, adminName: adminUser.name, adminEmail: adminUser.email, adminPassword: ctx.config.password, timezone: ORG.timezone },
    ctx.correlationId,
  );
  ctx.log(`created Tech admin ${adminUser.email} via first-run setup`);
  return userId;
}

/** Who approves a new person: the first Head is a bootstrap (only the Tech admin exists), everyone else a Head. */
type UserApproval = { bootstrap: true } | { checker: ActorContext };

/**
 * A demo person, created pending by the Tech admin and activated by the approval of their creation
 * (PM/research/11 §3.4). Resumes a creation left pending by an interrupted run.
 */
async function ensureUser(ctx: SeedContext, admin: ActorContext, user: DemoUser, teamIds: string[], approval: UserApproval): Promise<string> {
  const [row] = await ctx.db.select({ id: users.id, status: users.status }).from(users).where(sql`lower(${users.email}) = lower(${user.email})`);
  if (row?.status === 'ACTIVE') return row.id;
  const reason = `Demo seed: ${user.name} joins as ${user.role}`;
  const choice = 'bootstrap' in approval ? { bootstrap: true as const, reason } : { checkerId: approval.checker.principal!.userId, reason };
  let id: string;
  let proposalId: string | null;
  if (!row) {
    const view = await ctx.services.users.create(admin, {
      email: user.email,
      name: user.name,
      role: user.role,
      password: ctx.config.password,
      teamIds,
      languages: user.languages,
      skills: user.skills,
      maxConcurrent: user.maxConcurrent,
      approval: choice,
    });
    id = view.id;
    proposalId = view.proposal?.id ?? null;
  } else if (row.status === 'PENDING_APPROVAL') {
    id = row.id;
    const open = await unfinishedProposal(ctx, 'user', id);
    proposalId = open?.id ?? (await ctx.services.users.update(admin, id, { approval: choice })).proposal?.id ?? null;
  } else {
    throw new Error(`${user.email} exists but is ${row.status.toLowerCase()}; the demo seed only runs on a fresh database`);
  }
  if (proposalId) await ('checker' in approval ? approveProposal(ctx, approval.checker, proposalId) : finishDeferred(ctx, admin, proposalId));
  ctx.log(`created ${user.role} ${user.email} (${'bootstrap' in approval ? 'bootstrap approval: no other checker exists yet' : `approved by ${approval.checker.principal!.displayName}`})`);
  return id;
}

async function ensureTeams(ctx: SeedContext, lead: ActorContext): Promise<Record<TeamKey, string>> {
  const rows = await ctx.db.select({ id: teams.id, name: teams.name }).from(teams);
  const ids = {} as Record<TeamKey, string>;
  for (const [key, team] of Object.entries(TEAMS) as Array<[TeamKey, (typeof TEAMS)[TeamKey]]>) {
    const found = rows.find((r) => r.name.toLowerCase() === team.name.toLowerCase());
    ids[key] = found ? found.id : (await ctx.services.teams.create(lead, { name: team.name, description: team.description })).id;
  }
  return ids;
}

/** Organization identity, the five demo people (all three roles, two Leads) and their teams. */
export async function seedOrganization(ctx: SeedContext): Promise<SeededPeople> {
  const adminId = await ensureAdmin(ctx);
  const admin = actorFor(ctx, { id: adminId, name: adminUser.name, role: adminUser.role });

  // The first Head: only the Tech admin exists, so her creation is the one bootstrap approval (PM/research/11 §4.2).
  // She manages teams, so she exists before them and keeps only her own after creating them.
  const leadId = await ensureUser(ctx, admin, leadUser, [], { bootstrap: true });
  const lead0 = actorFor(ctx, { id: leadId, name: leadUser.name, role: leadUser.role });
  const teamIds = await ensureTeams(ctx, lead0);
  const leadTeams = leadUser.teams.map((t) => teamIds[t]);
  // Leaving the Sales team she created only takes access away: it applies at once.
  await ctx.services.users.update(admin, leadId, { teamIds: leadTeams, reason: 'Demo seed: Anjali keeps Cards & EMI and Hardship' });
  const lead = actorFor(ctx, { id: leadId, name: leadUser.name, role: leadUser.role, teamIds: leadTeams });

  // Everyone after her is proposed by the Tech admin and checked by a Head.
  const salesTeams = salesLeadUser.teams.map((t) => teamIds[t]);
  const salesLeadId = await ensureUser(ctx, admin, salesLeadUser, salesTeams, { checker: lead });
  const lead2 = actorFor(ctx, { id: salesLeadId, name: salesLeadUser.name, role: salesLeadUser.role, teamIds: salesTeams });

  const ids = { admin: adminId, lead: leadId, lead2: salesLeadId } as Record<DemoUser['key'], string>;
  for (const user of USERS.filter((u) => u.role === 'SERVICE')) {
    ids[user.key] = await ensureUser(ctx, admin, user, user.teams.map((t) => teamIds[t]), { checker: lead });
  }

  // Organization identity and residency are deployment settings: the Tech admin proposes, a Head checks.
  const settings = await ctx.services.settings.deployment();
  const wanted = { orgName: ORG.orgName, deploymentLabel: ORG.deploymentLabel, regionLabel: ORG.regionLabel, timezone: ORG.timezone, residencyZone: ORG.residencyZone };
  const deployment = Object.fromEntries(Object.entries(wanted).filter(([k, v]) => (settings as unknown as Record<string, unknown>)[k] !== v));
  if (Object.keys(deployment).length) {
    await approveAs(ctx, admin, lead, { objectKind: 'deployment_settings', objectId: SETTINGS_OBJECT_ID, action: 'UPDATE', payload: { deployment } }, 'Demo seed: Meridian Bank identity and residency');
    ctx.log(`deployment settings: ${Object.keys(deployment).join(', ')} (approved by ${leadUser.name})`);
  }
  return { admin, lead, leads: { lead, lead2 }, ids, teamIds };
}
