import { asc, eq, sql } from 'drizzle-orm';
import { Permission, assertCan, type RightsState } from '@ocso/auth';
import { conflict, forbidden, notFound, validation } from '@ocso/domain';
import { teamMembers, users, uuidv7, type Db } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import type { AuthMailer } from './auth-mailer.js';
import { createPasswordToken, deleteUserVerifications, hasPasswordCredential, setPasswordCredential } from './credentials.js';
import { hashPassword, passwordProblems } from './password.js';
import { activateUser } from './permissions/apply.js';
import { skipMarker, type ApprovalRequirement, type IdentityGovernance, type IdentityProposalRef } from './permissions/gate.js';
import { assertMayChangeRights } from './permissions/makers.js';
import { loadUserRights } from './permissions/state.js';
import { ADMIN_RESET_TTL_HOURS, DEFAULT_INVITE_TTL_HOURS, deliverInvite, type Onboarding } from './user-onboarding.js';
import { discardPendingUser, removePendingUser, submitUserProposal, updateUser } from './user-update.js';
import { addTeams, hasSignInMethod } from './user-writes.js';
import { toUserView, type UserView } from './user-view.js';
import { CreateUserInput, UpdateUserInput } from './user-inputs.js';

export { type InviteStatus, type UserView } from './user-view.js';
export { CreateUserInput, UpdateUserInput } from './user-inputs.js';
export { ADMIN_RESET_TTL_HOURS, DEFAULT_INVITE_TTL_HOURS, type Onboarding } from './user-onboarding.js';

/** A created user: pending approval unless the deployment skips it (development only). */
export type CreatedUser = UserView & { onboarding: Onboarding; proposal: IdentityProposalRef | null; approvalRequired: ApprovalRequirement | null };
/** An update: applied, or (for an increase) submitted for approval with the reductions and profile fields applied. */
export type UpdatedUser = UserView & { proposal: IdentityProposalRef | null; onboarding?: Onboarding };

export interface UserServiceOptions extends IdentityGovernance {
  /** Sends invites; without it users can only be created with an initial password. */
  mailer?: AuthMailer | null | undefined;
  /** Allow admin-set initial passwords (default: only when the mailer cannot deliver). */
  allowInitialPasswords?: boolean | undefined;
  inviteTtlHours?: number | undefined;
}

/**
 * Users (docs/09, PM/research/11 §3). New users are created PENDING_APPROVAL
 * (inert, cannot sign in); approval activates them and sends the invite
 * (ADR-025). Preset upgrades, re-enabling and team additions are increases and
 * go through approval; downgrades, disabling and team removals apply at once.
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

  /** Whether new users need approval here (false only in development deployments that skip it). */
  get approvalRequired(): boolean {
    return !this.options.skipAccessApproval;
  }

  async list(actor: ActorContext): Promise<UserView[]> {
    assertCan(actor.principal!, Permission.USERS_READ);
    const rows = await this.db.select().from(users).orderBy(asc(users.name));
    const memberships = await this.db.select().from(teamMembers);
    return rows.map((u) => toUserView(u, memberships.filter((m) => m.userId === u.id).map((m) => m.teamId)));
  }

  async create(actor: ActorContext, raw: CreateUserInput): Promise<CreatedUser> {
    const input = CreateUserInput.parse(raw);
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.USERS_MANAGE, 'no principal');
    const email = input.email.toLowerCase();
    if (input.password !== undefined) {
      if (!this.allowInitialPasswords) throw validation('initial_password_not_allowed', 'Email delivery is configured: invite the user instead of setting a password');
      const problems = passwordProblems(input.password);
      if (problems.length) throw validation('weak_password', `Password ${problems.join(', ')}`);
    } else if (!this.options.mailer) {
      throw validation('invites_unavailable', 'Invites are not available here: set an initial password');
    }
    const after: RightsState = { role: input.role, status: 'ACTIVE', teamIds: [...new Set(input.teamIds)], overrides: [] };
    assertMayChangeRights(principal, { targetId: null, before: null, after, ops: false, presetOrTeams: true, teamsTouched: after.teamIds });
    const id = uuidv7();
    const passwordHash = input.password !== undefined ? await hashPassword(input.password) : null;
    const direct = Boolean(this.options.skipAccessApproval);
    await this.db.transaction(async (tx) => {
      const existing = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`);
      if (existing.length) throw conflict('email_taken', 'A user with this email already exists');
      await tx.insert(users).values({
        id,
        email,
        name: input.name,
        role: input.role,
        status: 'PENDING_APPROVAL',
        emailVerified: false,
        languages: input.languages,
        skills: input.skills,
        maxConcurrent: input.maxConcurrent,
      });
      if (passwordHash) await setPasswordCredential(tx, id, passwordHash);
      await addTeams(tx, id, after.teamIds);
      await recordAudit(tx, actor, {
        action: 'user.create',
        targetType: 'user',
        targetId: id,
        summary: `Created ${input.role} ${email}${direct ? '' : ' (pending approval)'}`,
        after: { email, role: input.role, teamIds: after.teamIds, onboarding: passwordHash ? 'password' : 'invite' },
      });
      // Development deployments only: the approval step is skipped, through the same activation it would run.
      if (direct) await activateUser(tx, actor, id, { approvalSkipped: skipMarker(this.options) });
    });
    if (direct) {
      const onboarding = await this.sendActivationInvite(actor, id);
      return { ...(await this.get(id)), onboarding, proposal: null, approvalRequired: null };
    }

    const requirement: ApprovalRequirement = { objectKind: 'user', action: 'CREATE', objectId: id };
    if (!input.approval) {
      // A draft: inert until someone submits its creation (PATCH with `approval`), or discarded.
      return { ...(await this.get(id)), onboarding: { kind: 'pending_approval' }, proposal: null, approvalRequired: requirement };
    }
    let proposal: IdentityProposalRef;
    try {
      proposal = await submitUserProposal(this.db, this.options, actor, id, 'CREATE', input.approval, input.approval.reason ?? `Create ${input.role} ${email}`);
    } catch (err) {
      // The request failed as a whole: nothing stays behind (the email is free to try again).
      await this.db.transaction((tx) => removePendingUser(tx, actor, id, email, `Discarded ${email}: its creation could not be submitted for approval`));
      throw err;
    }
    return { ...(await this.get(id)), onboarding: { kind: 'pending_approval' }, proposal, approvalRequired: null };
  }

  /**
   * First sign-in for a user who just became ACTIVE: nothing to do when they
   * have a password, else a fresh invite link. The deferred half of approving
   * a new user (wave 2's `user` descriptor calls it after the approval commits).
   */
  async sendActivationInvite(actor: ActorContext, id: string): Promise<Onboarding> {
    const user = await this.get(id);
    if (user.status !== 'ACTIVE') throw conflict('user_not_active', `${user.email} is not active`);
    if (await hasPasswordCredential(this.db, id)) return { kind: 'password' };
    const mailer = this.options.mailer;
    if (!mailer) throw validation('invites_unavailable', 'Invites are not available here');
    const token = await this.issueInviteToken(id);
    return deliverInvite(this.db, mailer, actor, user, token, 'user.invite_sent');
  }

  /** Send a fresh invite link (the previous one stops working). Only before the invite is accepted. */
  async resendInvite(actor: ActorContext, id: string): Promise<UserView & { onboarding: Onboarding }> {
    const user = await this.assertManages(actor, id);
    if (!this.options.mailer) throw validation('invites_unavailable', 'Invites are not available here');
    if (user.status === 'PENDING_APPROVAL') throw conflict('user_pending_approval', 'The invite is sent once this user is approved');
    if (user.status !== 'ACTIVE') throw conflict('user_disabled', 'Enable the user before inviting them again');
    if (await hasSignInMethod(this.db, id)) throw conflict('invite_already_accepted', 'This user has already set up their sign-in');
    const token = await this.issueInviteToken(id);
    const onboarding = await deliverInvite(this.db, this.options.mailer, actor, user, token, 'user.invite_resent');
    return { ...(await this.get(id)), onboarding };
  }

  /**
   * Send a colleague a single-use set-password link, e.g. after they lost
   * access. Their sessions end when they use it. With the log email driver the
   * link comes back to hand over.
   */
  async sendPasswordReset(actor: ActorContext, id: string): Promise<{ expiresAt: string; delivery: { delivered: boolean; error?: string }; link: string | null }> {
    const user = await this.assertManages(actor, id);
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

  /**
   * Profile fields apply at once. Rights (preset, status, teams) are split:
   * what only takes access away applies at once; what widens it is proposed
   * (202) or refused with 409 approval_required (see updateUser).
   */
  async update(actor: ActorContext, id: string, raw: UpdateUserInput): Promise<UpdatedUser> {
    const outcome = await updateUser(this.db, this.options, actor, id, raw);
    if (outcome === 'activated') {
      // Development deployments: a pending user activated at once gets their invite now.
      const onboarding = await this.sendActivationInvite(actor, id);
      return { ...(await this.get(id)), proposal: null, onboarding };
    }
    return { ...(await this.get(id)), proposal: outcome };
  }

  /** DELETE /v1/users/:id: discard a user whose creation was never approved. */
  async discard(actor: ActorContext, id: string): Promise<void> {
    await discardPendingUser(this.db, this.options, actor, id);
  }

  /** A fresh single-use invite link; the previous one stops working. */
  private issueInviteToken(id: string) {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      await deleteUserVerifications(tx, id);
      const next = await createPasswordToken(tx, id, this.inviteTtlHours * 3600, now);
      await tx.update(users).set({ invitedAt: now, inviteExpiresAt: next.expiresAt, updatedAt: now }).where(eq(users.id, id));
      return next;
    });
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

  /** Invites, resets and profile edits: the same maker rules as a change that keeps the user's rights. */
  private async assertManages(actor: ActorContext, id: string): Promise<UserView> {
    const principal = actor.principal;
    if (!principal) throw forbidden(Permission.USERS_MANAGE, 'no principal');
    const rights = await loadUserRights(this.db, id);
    if (principal.userId === id) throw forbidden('users.manage', 'use Forgot password or Account security for your own account');
    assertMayChangeRights(principal, { targetId: id, before: rights, after: rights, ops: false, presetOrTeams: true, teamsTouched: [] });
    return this.get(id);
  }
}
