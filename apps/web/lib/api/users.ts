import 'server-only';
import { ROLES, type Role } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';

export const AVAILABILITY = ['AVAILABLE', 'AWAY', 'OFFLINE'] as const;
export type Availability = (typeof AVAILABILITY)[number];

/** UserView from GET /v1/users (packages/application identity/users.ts). */
export const UserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  status: z.enum(['ACTIVE', 'DISABLED']),
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

const CreatedUser = UserSchema.extend({
  onboarding: z.union([z.object({ kind: z.literal('password') }), LinkResult.extend({ kind: z.literal('invite') })]),
});
export type CreatedUser = z.infer<typeof CreatedUser>;

const Onboarding = z.object({ emailDelivery: z.enum(['email', 'log']), inviteTtlHours: z.number(), allowInitialPasswords: z.boolean() });
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

/** Invites a user (Tech admin: any role; Lead: Service members — enforced by the API). */
export function createUser(input: CreateUserRequest): Promise<CreatedUser> {
  return api.post('/v1/users', input, CreatedUser);
}

/** How invites reach people here: by email, or as links to hand over (log driver). */
export function getOnboarding(): Promise<Onboarding> {
  return api.get('/v1/users/onboarding', Onboarding);
}

export function resendInvite(userId: string): Promise<CreatedUser> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/invite`, {}, CreatedUser);
}

export function sendPasswordReset(userId: string): Promise<LinkResult> {
  return api.post(`/v1/users/${encodeURIComponent(userId)}/password-reset`, {}, LinkResult);
}

/** PATCH /v1/users/:id { teamIds } — replaces the user's teams (a Lead may change only their own teams, for Service members). */
export function updateUserTeams(userId: string, teamIds: string[]): Promise<void> {
  return api.command('PATCH', `/v1/users/${encodeURIComponent(userId)}`, { teamIds });
}

export function setMyAvailability(availability: Availability): Promise<void> {
  return api.command('PUT', '/v1/me/availability', { availability });
}
