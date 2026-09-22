import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Permission, Role, assertCan, can } from '@ocso/auth';
import { DomainError, conflict, forbidden, notFound, validation } from '@ocso/domain';
import { sessions, teamMembers, teams, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { hashPassword, passwordProblems } from './password.js';

export const CreateUserInput = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(['PLATFORM_TECH_ADMIN', 'CS_LEAD', 'CS_EXEC']),
  password: z.string().min(12).max(256),
  teamIds: z.array(z.uuid()).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  skills: z.array(z.string().max(60)).max(50).default([]),
  maxConcurrent: z.number().int().min(1).max(50).default(8),
});
export type CreateUserInput = z.infer<typeof CreateUserInput>;

export const UpdateUserInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(['PLATFORM_TECH_ADMIN', 'CS_LEAD', 'CS_EXEC']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  teamIds: z.array(z.uuid()).optional(),
  languages: z.array(z.string().max(20)).max(20).optional(),
  skills: z.array(z.string().max(60)).max(50).optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: 'ACTIVE' | 'DISABLED';
  availability: 'AVAILABLE' | 'AWAY' | 'OFFLINE';
  maxConcurrent: number;
  languages: string[];
  skills: string[];
  teamIds: string[];
  lastLoginAt: string | null;
}

/**
 * Users and roles. Tech Admin manages every role; a CS Lead may manage CS Execs
 * only (docs/09 §6 "team management subject to policy").
 */
export class UserService {
  constructor(private readonly db: Db) {}

  private assertCanManage(actor: ActorContext, targetRole: Role): void {
    const p = actor.principal;
    if (!p) throw forbidden('users.manage', 'no principal');
    if (can(p, Permission.USERS_MANAGE)) return;
    if (can(p, Permission.USERS_MANAGE_EXECS) && targetRole === Role.CS_EXEC) return;
    throw forbidden('users.manage', `cannot manage ${targetRole} users`);
  }

  async list(actor: ActorContext): Promise<UserView[]> {
    assertCan(actor.principal!, Permission.USERS_READ);
    const rows = await this.db.select().from(users).orderBy(asc(users.name));
    const memberships = await this.db.select().from(teamMembers);
    return rows.map((u) => toView(u, memberships.filter((m) => m.userId === u.id).map((m) => m.teamId)));
  }

  async create(actor: ActorContext, input: CreateUserInput): Promise<UserView> {
    this.assertCanManage(actor, input.role);
    const problems = passwordProblems(input.password);
    if (problems.length) throw validation('weak_password', `Password ${problems.join(', ')}`);
    const id = uuidv7();
    const passwordHash = await hashPassword(input.password);
    await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${input.email})`);
      if (existing.length) throw conflict('email_taken', 'A user with this email already exists');
      await tx.insert(users).values({
        id,
        email: input.email,
        name: input.name,
        role: input.role,
        passwordHash,
        languages: input.languages,
        skills: input.skills,
        maxConcurrent: input.maxConcurrent,
      });
      await this.replaceTeams(tx, id, input.teamIds);
      await recordAudit(tx, actor, {
        action: 'user.create',
        targetType: 'user',
        targetId: id,
        summary: `Created ${input.role} ${input.email}`,
        after: { email: input.email, role: input.role, teamIds: input.teamIds },
      });
    });
    return this.get(id);
  }

  async update(actor: ActorContext, id: string, input: UpdateUserInput): Promise<UserView> {
    const before = await this.get(id);
    this.assertCanManage(actor, before.role);
    if (input.role) this.assertCanManage(actor, input.role);
    if (actor.principal?.userId === id && (input.role || input.status === 'DISABLED')) {
      throw forbidden('users.manage', 'you cannot change your own role or disable yourself');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.languages !== undefined ? { languages: input.languages } : {}),
          ...(input.skills !== undefined ? { skills: input.skills } : {}),
          ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      if (input.teamIds) await this.replaceTeams(tx, id, input.teamIds);
      // Role change or deactivation invalidates existing sessions immediately.
      if ((input.role && input.role !== before.role) || input.status === 'DISABLED') {
        await tx.update(sessions).set({ revokedAt: new Date() }).where(and(eq(sessions.userId, id), isNull(sessions.revokedAt)));
      }
      await recordAudit(tx, actor, {
        action: input.role && input.role !== before.role ? 'user.role_change' : 'user.update',
        targetType: 'user',
        targetId: id,
        summary: `Updated ${before.email}`,
        before,
        after: input,
      });
    });
    return this.get(id);
  }

  async setAvailability(actor: ActorContext, availability: UserView['availability']): Promise<void> {
    const p = actor.principal;
    if (!p) throw forbidden('users.availability');
    await this.db.update(users).set({ availability, updatedAt: new Date() }).where(eq(users.id, p.userId));
  }

  async get(id: string): Promise<UserView> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!row) throw notFound('user', id);
    const memberships = await this.db.select().from(teamMembers).where(eq(teamMembers.userId, id));
    return toView(row, memberships.map((m) => m.teamId));
  }

  private async replaceTeams(tx: DbOrTx, userId: string, teamIds: readonly string[]): Promise<void> {
    if (teamIds.length) {
      const found = await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, [...teamIds]));
      if (found.length !== new Set(teamIds).size) throw new DomainError('validation', 'unknown_team', 'One or more teams do not exist');
    }
    await tx.delete(teamMembers).where(eq(teamMembers.userId, userId));
    if (teamIds.length) await tx.insert(teamMembers).values([...new Set(teamIds)].map((teamId) => ({ teamId, userId })));
  }
}

function toView(u: typeof users.$inferSelect, teamIds: string[]): UserView {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    status: u.status,
    availability: u.availability,
    maxConcurrent: u.maxConcurrent,
    languages: u.languages,
    skills: u.skills,
    teamIds,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  };
}
