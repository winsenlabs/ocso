import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { Permission, ROLES, ROLE_LABELS, ROLE_PERMISSIONS, Role, assertCan, can, rightsWithin } from '@ocso/auth';
import { DomainError, conflict, forbidden, notFound, validation } from '@ocso/domain';
import { authAccounts, authPasskeys, teamMembers, teams, users, uuidv7, type Db, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import type { AuthMailer, MailOutcome } from './auth-mailer.js';
import { CREDENTIAL_PROVIDER, createPasswordToken, deleteUserVerifications, revokeUserSessions, setPasswordCredential } from './credentials.js';
import { hashPassword, passwordProblems } from './password.js';
import { toUserView, type UserView } from './user-view.js';

export { type InviteStatus, type UserView } from './user-view.js';

export const CreateUserInput = z.object({
  email: z.email().max(320),
  name: z.string().trim().min(1).max(200),
  role: z.enum(ROLES),
  /** Admin-set initial password: only when invites cannot be emailed (EMAIL_DRIVER=log). */
  password: z.string().min(12).max(256).optional(),
  teamIds: z.array(z.uuid()).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  skills: z.array(z.string().max(60)).max(50).default([]),
  maxConcurrent: z.number().int().min(1).max(50).default(8),
});
export type CreateUserInput = z.input<typeof CreateUserInput>;

export const UpdateUserInput = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  role: z.enum(ROLES).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  teamIds: z.array(z.uuid()).optional(),
  languages: z.array(z.string().max(20)).max(20).optional(),
  skills: z.array(z.string().max(60)).max(50).optional(),
  maxConcurrent: z.number().int().min(1).max(50).optional(),
});
export type UpdateUserInput = z.infer<typeof UpdateUserInput>;

/** What the create call did about the new user's first sign-in. */
export type Onboarding =
  | { kind: 'password' }
  | { kind: 'invite'; expiresAt: string; delivery: MailOutcome; /** Only for EMAIL_DRIVER=log: the admin shares it. */ link: string | null };

export interface UserServiceOptions {
  /** Sends invites; without it users can only be created with an initial password. */
  mailer?: AuthMailer | null | undefined;
  /** Allow admin-set initial passwords (default: only when the mailer cannot deliver). */
  allowInitialPasswords?: boolean | undefined;
  inviteTtlHours?: number | undefined;
}

export const DEFAULT_INVITE_TTL_HOURS = 72;
/** Admin-initiated reset links are handed over by a person, so they live longer than self-service ones (1 h). */
export const ADMIN_RESET_TTL_HOURS = 24;

/**
 * Users and roles. Tech admin manages every role; a Lead may manage Service members
 * only (docs/09 §6). New users are invited by email (ADR-025): they choose
 * their own password through a single-use link.
 */
export class UserService {
  constructor(
    private readonly db: Db,
    private readonly options: UserServiceOptions = {},
  ) {}

  /** Admin-set passwords are the fallback for deployments that cannot email invites. */
  get allowInitialPasswords(): boolean {
    return this.options.allowInitialPasswords ?? !this.options.mailer?.delivers;
  }

  get inviteTtlHours(): number {
    return this.options.inviteTtlHours ?? DEFAULT_INVITE_TTL_HOURS;
  }

  private assertCanManage(actor: ActorContext, targetRole: Role): void {
    const p = actor.principal;
    if (!p) throw forbidden('users.manage', 'no principal');
    if (can(p, Permission.USERS_MANAGE)) return;
    // Team managers shape only colleagues whose rights fit inside their own (PM/research/11 §3.4).
    if (can(p, Permission.USERS_MANAGE_TEAM) && rightsWithin(ROLE_PERMISSIONS[targetRole], p)) return;
    throw forbidden('users.manage', `cannot manage ${targetRole} users`);
  }

  async list(actor: ActorContext): Promise<UserView[]> {
    assertCan(actor.principal!, Permission.USERS_READ);
    const rows = await this.db.select().from(users).orderBy(asc(users.name));
    const memberships = await this.db.select().from(teamMembers);
    return rows.map((u) => toUserView(u, memberships.filter((m) => m.userId === u.id).map((m) => m.teamId)));
  }

  async create(actor: ActorContext, raw: CreateUserInput): Promise<UserView & { onboarding: Onboarding }> {
    const input = CreateUserInput.parse(raw);
    this.assertCanManage(actor, input.role);
    const email = input.email.toLowerCase();
    if (input.password !== undefined) {
      if (!this.allowInitialPasswords) throw validation('initial_password_not_allowed', 'Email delivery is configured: invite the user instead of setting a password');
      const problems = passwordProblems(input.password);
      if (problems.length) throw validation('weak_password', `Password ${problems.join(', ')}`);
    } else if (!this.options.mailer) {
      throw validation('invites_unavailable', 'Invites are not available here: set an initial password');
    }
    // Same rule as edits: a Lead can place a new exec only in teams they belong to.
    if (input.teamIds.length && !can(actor.principal!, Permission.USERS_MANAGE)) this.assertOwnTeams(actor, [], input.teamIds);
    const id = uuidv7();
    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;
    const now = new Date();
    const invite = await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (existing.length) throw conflict('email_taken', 'A user with this email already exists');
      const token = passwordHash ? null : await createPasswordToken(tx, id, this.inviteTtlHours * 3600, now);
      await tx.insert(users).values({
        id,
        email,
        name: input.name,
        role: input.role,
        emailVerified: false,
        invitedAt: token ? now : null,
        inviteExpiresAt: token?.expiresAt ?? null,
        languages: input.languages,
        skills: input.skills,
        maxConcurrent: input.maxConcurrent,
      });
      if (passwordHash) await setPasswordCredential(tx, id, passwordHash, now);
      await this.replaceTeams(tx, id, input.teamIds);
      await recordAudit(tx, actor, {
        action: 'user.create',
        targetType: 'user',
        targetId: id,
        summary: token ? `Invited ${input.role} ${email}` : `Created ${input.role} ${email} with an initial password`,
        after: { email, role: input.role, teamIds: input.teamIds, onboarding: token ? 'invite' : 'password' },
      });
      return token;
    });
    const onboarding: Onboarding = invite
      ? await this.deliverInvite(actor, { id, email, name: input.name, role: input.role }, invite, 'user.invite_sent')
      : { kind: 'password' };
    return { ...(await this.get(id)), onboarding };
  }

  /** Send a fresh invite link (the previous one stops working). Only before the invite is accepted. */
  async resendInvite(actor: ActorContext, id: string): Promise<UserView & { onboarding: Onboarding }> {
    const user = await this.get(id);
    this.assertCanManage(actor, user.role);
    if (!this.options.mailer) throw validation('invites_unavailable', 'Invites are not available here');
    if (user.status !== 'ACTIVE') throw conflict('user_disabled', 'Enable the user before inviting them again');
    if (await this.hasSignInMethod(this.db, id)) throw conflict('invite_already_accepted', 'This user has already set up their sign-in');
    const now = new Date();
    const token = await this.db.transaction(async (tx) => {
      await deleteUserVerifications(tx, id);
      const next = await createPasswordToken(tx, id, this.inviteTtlHours * 3600, now);
      await tx.update(users).set({ invitedAt: now, inviteExpiresAt: next.expiresAt, updatedAt: now }).where(eq(users.id, id));
      return next;
    });
    const onboarding = await this.deliverInvite(actor, user, token, 'user.invite_resent');
    return { ...(await this.get(id)), onboarding };
  }

  /**
   * A Tech admin (any role) or Lead (Service members) sends a user a single-use
   * set-password link, e.g. after they lost access. Their sessions end when
   * they use it. With the log email driver the link comes back to hand over.
   */
  async sendPasswordReset(actor: ActorContext, id: string): Promise<{ expiresAt: string; delivery: MailOutcome; link: string | null }> {
    const user = await this.get(id);
    this.assertCanManage(actor, user.role);
    if (actor.principal?.userId === id) throw forbidden('users.manage', 'use Forgot password or Account security for your own password');
    if (user.status !== 'ACTIVE') throw conflict('user_disabled', 'Enable the user first');
    const mailer = this.options.mailer;
    if (!mailer) throw validation('email_unavailable', 'Password reset links are not available here');
    const token = await createPasswordToken(this.db, id, ADMIN_RESET_TTL_HOURS * 3600);
    const delivery = await mailer.sendPasswordReset({ to: user.email, name: user.name, token: token.token, expiresAt: token.expiresAt });
    await recordAudit(this.db, actor, {
      action: 'user.password_reset_sent',
      targetType: 'user',
      targetId: id,
      summary: delivery.delivered
        ? `Password reset link ${mailer.delivers ? 'emailed to' : 'issued (log driver) for'} ${user.email}`
        : `Password reset link for ${user.email} could not be emailed: ${delivery.error}`,
    });
    return { expiresAt: token.expiresAt.toISOString(), delivery, link: mailer.delivers ? null : mailer.link('/reset-password', token.token) };
  }

  async update(actor: ActorContext, id: string, input: UpdateUserInput): Promise<UserView> {
    const before = await this.get(id);
    this.assertCanManage(actor, before.role);
    if (input.role) this.assertCanManage(actor, input.role);
    if (actor.principal?.userId === id && (input.role || input.status === 'DISABLED')) {
      throw forbidden('users.manage', 'you cannot change your own role or disable yourself');
    }
    if (input.teamIds && !can(actor.principal!, Permission.USERS_MANAGE)) this.assertOwnTeams(actor, before.teamIds, input.teamIds);
    const roleChanged = input.role !== undefined && input.role !== before.role;
    const disabling = input.status === 'DISABLED' && before.status !== 'DISABLED';
    await this.db.transaction(async (tx) => {
      if (before.role === Role.TECH && (roleChanged || disabling)) await this.assertBreakGlassRemains(tx, id);
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
      // Role change or deactivation ends every session immediately (open streams close within a minute).
      const revoked = roleChanged || disabling ? await revokeUserSessions(tx, id) : 0;
      await recordAudit(tx, actor, {
        action: roleChanged ? 'user.role_change' : 'user.update',
        targetType: 'user',
        targetId: id,
        summary: `Updated ${before.email}${revoked ? ` · ended ${revoked} session(s)` : ''}`,
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
    return toUserView(row, memberships.map((m) => m.teamId));
  }

  /** A Lead may move people only in and out of teams they belong to themselves. */
  private assertOwnTeams(actor: ActorContext, before: readonly string[], after: readonly string[]): void {
    const own = new Set(actor.principal?.teamIds ?? []);
    const changed = [...after.filter((t) => !before.includes(t)), ...before.filter((t) => !after.includes(t))];
    if (changed.some((t) => !own.has(t))) throw forbidden('users.manage_team', 'Leads change memberships of their own teams only');
  }

  /**
   * Break-glass guarantee: at least one active Tech admin keeps
   * password sign-in (plus MFA when required), so SSO or IdP trouble can never
   * lock the deployment out. Serialized so two admins cannot race past it.
   */
  private async assertBreakGlassRemains(tx: DbOrTx, excludingUserId: string): Promise<void> {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('ocso:tech-admins'))`);
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .innerJoin(authAccounts, and(eq(authAccounts.userId, users.id), eq(authAccounts.providerId, CREDENTIAL_PROVIDER), isNotNull(authAccounts.password)))
      .where(and(eq(users.role, Role.TECH), eq(users.status, 'ACTIVE'), ne(users.id, excludingUserId)));
    if ((row?.n ?? 0) === 0) {
      throw conflict('last_password_admin', 'At least one active Tech admin must keep password sign-in. Add or enable another one first.');
    }
  }

  private async hasSignInMethod(db: DbOrTx, userId: string): Promise<boolean> {
    const [account] = await db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId)).limit(1);
    if (account) return true;
    const [passkey] = await db.select({ id: authPasskeys.id }).from(authPasskeys).where(eq(authPasskeys.userId, userId)).limit(1);
    return Boolean(passkey);
  }

  private async deliverInvite(
    actor: ActorContext,
    user: { id: string; email: string; name: string; role: Role },
    token: { token: string; expiresAt: Date },
    action: 'user.invite_sent' | 'user.invite_resent',
  ): Promise<Onboarding> {
    const mailer = this.options.mailer!;
    const delivery = await mailer.sendInvite({
      to: user.email,
      name: user.name,
      roleLabel: ROLE_LABELS[user.role],
      inviterName: actor.principal?.displayName ?? 'Your administrator',
      token: token.token,
      expiresAt: token.expiresAt,
    });
    await recordAudit(this.db, actor, {
      action,
      targetType: 'user',
      targetId: user.id,
      summary: delivery.delivered
        ? `Invite ${mailer.delivers ? 'emailed' : 'written to the log driver'} for ${user.email} (expires ${token.expiresAt.toISOString()})`
        : `Invite for ${user.email} could not be emailed: ${delivery.error}`,
    });
    // The log driver delivers nothing: the admin gets the link to share it out of band.
    return { kind: 'invite', expiresAt: token.expiresAt.toISOString(), delivery, link: mailer.delivers ? null : mailer.link('/invite', token.token) };
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
