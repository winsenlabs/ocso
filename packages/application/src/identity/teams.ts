import { asc, eq, sql } from 'drizzle-orm';
import { Permission, assertCan } from '@ocso/auth';
import { conflict, notFound } from '@ocso/domain';
import { teamMembers, teams, uuidv7, type Db } from '@ocso/db';
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

  async create(actor: ActorContext, input: TeamInput): Promise<TeamView> {
    assertCan(actor.principal!, Permission.TEAMS_MANAGE);
    const id = uuidv7();
    await this.db.transaction(async (tx) => {
      const clash = await tx.select({ id: teams.id }).from(teams).where(sql`lower(${teams.name}) = lower(${input.name})`);
      if (clash.length) throw conflict('team_exists', 'A team with this name already exists');
      await tx.insert(teams).values({ id, name: input.name, description: input.description });
      await recordAudit(tx, actor, { action: 'team.create', targetType: 'team', targetId: id, summary: `Created team ${input.name}` });
    });
    return { id, name: input.name, description: input.description, memberCount: 0 };
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
