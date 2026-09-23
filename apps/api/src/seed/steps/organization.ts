import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { SetupService, type ActorContext } from '@ocso/application';
import { teams, users } from '@ocso/db';
import { actorFor, type SeedContext } from '../context.js';
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

async function ensureUser(ctx: SeedContext, admin: ActorContext, user: DemoUser, teamIds: string[]): Promise<string> {
  const existing = await userIdByEmail(ctx, user.email);
  if (existing) return existing;
  const view = await ctx.services.users.create(admin, {
    email: user.email,
    name: user.name,
    role: user.role,
    password: ctx.config.password,
    teamIds,
    languages: user.languages,
    skills: user.skills,
    maxConcurrent: user.maxConcurrent,
  });
  ctx.log(`created ${user.role} ${user.email}`);
  return view.id;
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
  await ctx.services.settings.updateDeployment(admin, {
    orgName: ORG.orgName,
    deploymentLabel: ORG.deploymentLabel,
    regionLabel: ORG.regionLabel,
    timezone: ORG.timezone,
    residencyZone: ORG.residencyZone,
  });

  // The Lead manages teams, so she exists before them and joins them after.
  const leadId = await ensureUser(ctx, admin, leadUser, []);
  const lead0 = actorFor(ctx, { id: leadId, name: leadUser.name, role: leadUser.role });
  const teamIds = await ensureTeams(ctx, lead0);
  const leadTeams = leadUser.teams.map((t) => teamIds[t]);
  await ctx.services.users.update(admin, leadId, { teamIds: leadTeams });
  const lead = actorFor(ctx, { id: leadId, name: leadUser.name, role: leadUser.role, teamIds: leadTeams });

  const salesTeams = salesLeadUser.teams.map((t) => teamIds[t]);
  const salesLeadId = await ensureUser(ctx, admin, salesLeadUser, salesTeams);
  const lead2 = actorFor(ctx, { id: salesLeadId, name: salesLeadUser.name, role: salesLeadUser.role, teamIds: salesTeams });

  const ids = { admin: adminId, lead: leadId, lead2: salesLeadId } as Record<DemoUser['key'], string>;
  for (const user of USERS.filter((u) => u.role === 'SERVICE')) {
    ids[user.key] = await ensureUser(ctx, admin, user, user.teams.map((t) => teamIds[t]));
  }
  return { admin, lead, leads: { lead, lead2 }, ids, teamIds };
}
