import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { Permission, applyRightsChange, assertCan, can, classifyRightsChange, computeEffectivePermissions, rightsWithin, type Role, type UserStatus } from '@ocso/auth';
import { conflict, forbidden, notFound } from '@ocso/domain';
import { teamMembers, teams, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { applyPermissionChangeSet } from './permissions/apply.js';
import { ApprovalChoice } from './permissions/change-set.js';
import { proposeIncrease, skipMarker, type IdentityGovernance, type IdentityProposalRef } from './permissions/gate.js';
import { loadUserRights } from './permissions/state.js';

export const TeamInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(500).nullable().default(null),
});
export type TeamInput = z.infer<typeof TeamInput>;

/** POST /v1/teams/:id/members: joining a team widens someone's scope, so it goes through approval. */
export const AddMemberInput = z.object({
  userId: z.uuid(),
  reason: z.string().trim().min(3).max(500).optional(),
  approval: ApprovalChoice.optional(),
});
export type AddMemberInput = z.infer<typeof AddMemberInput>;

export interface TeamView {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
}

/** A member of a team as the team page shows them: who, their role, and since when. */
export interface TeamMemberView {
  userId: string;
  name: string;
  email: string;
  role: Role;
  status: UserStatus;
  availability: 'AVAILABLE' | 'AWAY' | 'OFFLINE';
  addedAt: string;
}

export interface TeamDetail extends TeamView {
  createdAt: string;
  members: TeamMemberView[];
}

export class TeamService {
  constructor(
    private readonly db: Db,
    private readonly governance: IdentityGovernance = {},
  ) {}

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

  /** One team with its members (users.read: the same people GET /v1/users already lists, plus when they joined). */
  async get(actor: ActorContext, id: string): Promise<TeamDetail> {
    assertCan(actor.principal!, Permission.USERS_READ);
    const [team] = await this.db.select().from(teams).where(eq(teams.id, id));
    if (!team) throw notFound('team', id);
    const members = await this.db
      .select({ userId: users.id, name: users.name, email: users.email, role: users.role, status: users.status, availability: users.availability, addedAt: teamMembers.createdAt })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, id))
      .orderBy(asc(users.name));
    return {
      id: team.id,
      name: team.name,
      description: team.description,
      memberCount: members.length,
      createdAt: team.createdAt.toISOString(),
      members: members.map((m) => ({ ...m, addedAt: m.addedAt.toISOString() })),
    };
  }

  /**
   * The creating Lead joins the team: team ownership of agents (ADR-026) needs a
   * member to manage them. Exempt from approval on purpose: a new team owns no
   * agent, queue or conversation yet, so joining it widens nobody's reach; every
   * later membership of it is an ordinary (approved) change.
   */
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
   * Team membership. users.manage: anyone on any team. teams.manage: only on
   * teams they belong to, for colleagues whose rights fit inside their own.
   * Nobody adds themselves. Adding an approved user (ACTIVE or DISABLED) is a
   * scope increase (PM/research/11 §3.4): it is proposed for approval (or
   * refused with 409 approval_required); adding a pending user is a draft edit
   * and applies at once. Decided under the user's row lock.
   */
  async addMember(actor: ActorContext, teamId: string, input: AddMemberInput | string): Promise<{ proposal: IdentityProposalRef | null }> {
    const { userId, reason, approval } = typeof input === 'string' ? { userId: input, reason: undefined, approval: undefined } : AddMemberInput.parse(input);
    if (actor.principal?.userId === userId) throw forbidden(Permission.TEAMS_MANAGE, 'you cannot add yourself to a team; ask a colleague');
    const outcome = await this.db.transaction(async (tx) => {
      const before = await loadUserRights(tx, userId, { lock: true });
      const { team, user } = await this.assertCanChangeMembership(tx, actor, teamId, userId);
      const why = reason ?? approval?.reason ?? `Add ${user.email} to ${team.name}`;
      if (before.teamIds.includes(teamId)) return { propose: null };
      const classification = classifyRightsChange(before, applyRightsChange(before, { teams: { add: [teamId] } }));
      if (classification.direction === 'INCREASE' && !this.governance.skipAccessApproval) return { propose: why };
      await this.governance.onDirectRightsChange?.(tx, actor, { userId, kind: 'rights' });
      await applyPermissionChangeSet(tx, actor, { userId, teams: { add: [teamId], remove: [] }, ops: [], reason: why }, { approvalSkipped: skipMarker(this.governance) });
      await recordAudit(tx, actor, { action: 'team.member_add', targetType: 'team', targetId: teamId, summary: `Added ${user.email} to ${team.name}` });
      return { propose: null };
    });
    if (!outcome.propose) return { proposal: null };
    const proposal = await proposeIncrease(this.governance, actor, {
      objectKind: 'permission_change',
      objectId: userId,
      action: 'UPDATE',
      payload: { userId, makerId: actor.principal!.userId, teams: { add: [teamId], remove: [] }, ops: [], reason: outcome.propose },
      approval,
      reason: outcome.propose,
    });
    return { proposal };
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
    if (!membership) throw forbidden(Permission.TEAMS_MANAGE, 'You manage only the teams you belong to');
    const rights = user.id === principal.userId ? null : await loadUserRights(tx, user.id);
    if (rights && !rightsWithin(computeEffectivePermissions(rights.role, rights.overrides), principal)) {
      throw forbidden(Permission.TEAMS_MANAGE, 'You manage the memberships of colleagues whose rights do not exceed yours (and your own)');
    }
    return { team, user };
  }

  /** Rename / describe. A Lead changes only teams they belong to (the same rule as memberships). */
  async update(actor: ActorContext, id: string, input: TeamInput): Promise<void> {
    const principal = actor.principal!;
    assertCan(principal, Permission.TEAMS_MANAGE);
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(teams).where(eq(teams.id, id));
      if (!before) throw notFound('team', id);
      const [membership] = await tx.select({ teamId: teamMembers.teamId }).from(teamMembers).where(and(eq(teamMembers.teamId, id), eq(teamMembers.userId, principal.userId)));
      if (!membership) throw forbidden(Permission.TEAMS_MANAGE, 'You manage only the teams you belong to');
      const clash = await tx.select({ id: teams.id }).from(teams).where(and(sql`lower(${teams.name}) = lower(${input.name})`, ne(teams.id, id)));
      if (clash.length) throw conflict('team_exists', 'A team with this name already exists');
      await tx.update(teams).set({ name: input.name, description: input.description, updatedAt: new Date() }).where(eq(teams.id, id));
      await recordAudit(tx, actor, { action: 'team.update', targetType: 'team', targetId: id, summary: `Updated team ${input.name}`, before, after: input });
    });
  }
}
