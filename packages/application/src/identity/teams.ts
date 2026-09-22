import { and, asc, eq, sql } from 'drizzle-orm';
import { Permission, Role, assertCan, can } from '@ocso/auth';
import { conflict, forbidden, notFound } from '@ocso/domain';
import { teamMembers, teams, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';

export const TeamInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
});
export type TeamInput = z.infer<typeof TeamInput>;

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

export class TeamService {
  constructor(private readonly db: Db) {}

  async list(): Promise<TeamView[]> {
    const rows = await this.db
      .select({
        id: teams.id,
        name: teams.name,
        description: teams.description,
        memberCount: sql<number>`(SELECT count(*)::int FROM ${teamMembers} WHERE ${teamMembers.teamId} = ${teams.id})`,
      })
      .from(teams)
      .orderBy(asc(teams.name));
    return rows;
  }

  /** The creating CS Lead joins the team: team ownership of agents (ADR-026) needs a member to manage them. */
  async create(actor: ActorContext, input: TeamInput): Promise<TeamView> {
    const principal = actor.principal!;
    assertCan(principal, Permission.TEAMS_MANAGE);
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      const clash = await tx.select({ id: teams.id }).from(teams).where(sql`lower(${teams.name}) = lower(${input.name})`);
      if (clash.length) throw conflict('team_exists', 'A team with this name already exists');
      await tx.insert(teams).values({ id, name: input.name, description: input.description });
      await tx.insert(teamMembers).values({ teamId: id, userId: principal.userId });
      await recordAudit(tx, actor, { action: 'team.create', targetType: 'team', targetId: id, summary: `Created team ${input.name} (creator joined it)` });
    });
    return { id, name: input.name, description: input.description, memberCount: 1 };
  }

  /**
   * Team membership. Tech Admin: anyone on any team. CS Lead: only on teams
   * they belong to, and only CS Execs or themselves.
   */
  async addMember(actor: ActorContext, teamId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { team, user } = await this.assertCanChangeMembership(tx, actor, teamId, userId);
      const added = await tx.insert(teamMembers).values({ teamId, userId }).onConflictDoNothing().returning({ userId: teamMembers.userId });
      if (added.length) await recordAudit(tx, actor, { action: 'team.member_add', targetType: 'team', targetId: teamId, summary: `Added ${user.email} to ${team.name}` });
    });
  }

  async removeMember(actor: ActorContext, teamId: string, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { team, user } = await this.assertCanChangeMembership(tx, actor, teamId, userId);
      const removed = await tx.delete(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId))).returning({ userId: teamMembers.userId });
      if (removed.length) await recordAudit(tx, actor, { action: 'team.member_remove', targetType: 'team', targetId: teamId, summary: `Removed ${user.email} from ${team.name}` });
    });
  }

  private async assertCanChangeMembership(tx: DbOrTx, actor: ActorContext, teamId: string, userId: string) {
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.TEAMS_MANAGE);
    const [team] = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(eq(teams.id, teamId));
    if (!team) throw notFound('team', teamId);
    const [user] = await tx.select({ id: users.id, email: users.email, role: users.role }).from(users).where(eq(users.id, userId));
    if (!user) throw notFound('user', userId);
    if (can(principal, Permission.USERS_MANAGE)) return { team, user };
    if (!can(principal, Permission.TEAMS_MANAGE)) throw forbidden(Permission.TEAMS_MANAGE);
    const [membership] = await tx.select({ teamId: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, principal.userId)));
    if (!membership) throw forbidden(Permission.TEAMS_MANAGE, 'CS Leads manage only the teams they belong to');
    if (user.id !== principal.userId && user.role !== Role.CS_EXEC) throw forbidden(Permission.TEAMS_MANAGE, 'CS Leads manage CS Exec memberships (and their own) only');
    return { team, user };
  }

  async update(actor: ActorContext, id: string, input: TeamInput): Promise<void> {
    assertCan(actor.principal!, Permission.TEAMS_MANAGE);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(teams).where(eq(teams.id, id));
      if (!before) throw notFound('team', id);
      await tx.update(teams).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(teams.id, id));
      await recordAudit(tx, actor, { action: 'team.update', targetType: 'team', targetId: id, summary: `Updated team ${input.name}`, before, after: input });
    });
  }
}
