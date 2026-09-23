import 'server-only';
import { ROLES, type Role } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';

export const AVAILABILITY = ['AVAILABLE', 'AWAY', 'OFFLINE'] as const;
/** PENDING_APPROVAL: created, inert and unable to sign in until approved (PM/research/11 §3.4). */
export const USER_STATUSES = ['ACTIVE', 'DISABLED', 'PENDING_APPROVAL'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];
export type Availability = (typeof AVAILABILITY)[number];

/** UserView from GET /v1/users (packages/application identity/users.ts). */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  availability: z.enum(AVAILABILITY),
  maxConcurrent: z.number(),
  languages: z.array(z.string()),
  skills: z.array(z.string()),
  teamIds: z.array(z.string()),
  lastLoginAt: z.string().nullable(),
  /** Invite state (ADR-025): none = created with a password / by setup / SSO. */
  invite: z.object({ status: z.enum(['none', 'pending', 'expired', 'accepted']), expiresAt: z.string().nullable() }).default({ status: 'none', expiresAt: null }),
  mfaEnabled: z.boolean().default(false),
});
export type User = z.infer<typeof UserSchema>;

const Delivery = z.object({ delivered: z.boolean(), error: z.string().optional() });
/** Set-password link handed back only when the email driver is `log` (nothing is really sent). */
const LinkResult = z.object({ expiresAt: z.string(), delivery: Delivery, link: z.string().nullable() });
export type LinkResult = z.infer<typeof LinkResult>;

/** An increase waiting for a checker (the approval spine's proposal, as the write endpoints return it). */
export const ProposalRefSchema = z.object({ id: z.string(), objectKind: z.string(), objectId: z.string(), action: z.string(), status: z.string(), checkerId: z.string().nullable(), bootstrap: z.boolean() });
export type ProposalRef = z.infer<typeof ProposalRefSchema>;
/** What a refused or pending increase needs: `{objectKind, action, objectId}` of the approval to submit. */
export const ApprovalRequirementSchema = z.object({ objectKind: z.enum(['user', 'permission_change']), action: z.string(), objectId: z.string() });

const CreatedUser = UserSchema.extend({
  onboarding: z.union([z.object({ kind: z.literal('password') }), z.object({ kind: z.literal('pending_approval') }), LinkResult.extend({ kind: z.literal('invite') })]),
  proposal: ProposalRefSchema.nullable().default(null),
  approvalRequired: ApprovalRequirementSchema.nullable().default(null),
});
export type CreatedUser = z.infer<typeof CreatedUser>;

const Onboarding = z.object({
  emailDelivery: z.enum(['email', 'log']),
  inviteTtlHours: z.number(),
  allowInitialPasswords: z.boolean(),
  /** New users wait for approval (false only on development deployments that skip it). */
  approvalRequired: z.boolean().default(true),
});
export type Onboarding = z.infer<typeof Onboarding>;

export interface CreateUserRequest {
  name: string;
  email: string;
  role: Role;
  teamIds: string[];
  languages: string[];
  maxConcurrent: number;
}

export function listUsers(): Promise<User[]> {
  return api.get('/v1/users', z.array(UserSchema));
}

/** Creates a user, pending approval unless the deployment skips it (maker rules enforced by the API). */
export function createUser(input: CreateUserRequest): Promise<CreatedUser> {
  return api.post('/v1/users', input, CreatedUser);
}

/** How invites reach people here: by email, or as links to hand over (log driver). */
export function getOnboarding(): Promise<Onboarding> {
  return api.get('/v1/users/onboarding', Onboarding);
}

const ResentInvite = UserSchema.extend({ onboarding: z.union([z.object({ kind: z.literal('password') }), LinkResult.extend({ kind: z.literal('invite') })]) });

export function resendInvite(userId: string): Promise<z.infer<typeof ResentInvite>> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/invite`, {}, ResentInvite);
}

export function sendPasswordReset(userId: string): Promise<LinkResult> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/password-reset`, {}, LinkResult);
}

/**
 * PATCH /v1/users/:id { teamIds } — replaces the user's teams. Removals apply; joining a team widens an
 * active user's access and answers 409 approval_required (or 202 with a proposal).
 */
export function updateUserTeams(userId: string, teamIds: string[]): Promise<void> {
  return api.command('PATCH', `/v1/users/${encodeURIComponent(userId)}`, { teamIds });
}

/** DELETE /v1/users/:id — discard a user whose creation was never approved (frees the email). */
export function discardUser(userId: string): Promise<void> {
  return api.command('DELETE', `/v1/users/${encodeURIComponent(userId)}`);
}

export function setMyAvailability(availability: Availability): Promise<void> {
  return api.command('PUT', '/v1/me/availability', { availability });
}
