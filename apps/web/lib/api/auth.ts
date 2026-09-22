import 'server-only';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';

const MfaStateSchema = z.object({ required: z.boolean(), satisfied: z.boolean(), enrolled: z.boolean() });
export type MfaState = z.infer<typeof MfaStateSchema>;

/** GET /v1/auth/me — the signed-in user as the API describes them. */
export const SessionUserSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(ROLES),
  teamIds: z.array(z.string()),
  permissions: z.array(z.string()),
  deployment: z.object({
    orgName: z.string(),
    label: z.string(),
    region: z.string().nullable(),
    timezone: z.string(),
  }),
  /** How this session was established (password | mfa | passkey | sso). */
  session: z.object({ id: z.string(), method: z.string(), expiresAt: z.string() }).nullable().optional(),
  /** "Require MFA for roles": pending when required and not satisfied by this session. */
  mfa: MfaStateSchema.optional(),
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

const SetupStatus = z.object({
  setupRequired: z.boolean(),
  orgName: z.string(),
  /** At least one SSO provider is configured (the sign-in page offers SSO). */
  sso: z.boolean().default(false),
  /** Break-glass recovery is enabled (OCSO_RECOVERY_TOKEN set). */
  recovery: z.boolean().default(false),
});
export type SetupStatus = z.infer<typeof SetupStatus>;

export interface SetupRequest {
  setupToken: string;
  orgName: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  timezone: string;
}

const SecuritySchema = z.object({ hasPassword: z.boolean(), mfa: MfaStateSchema.nullable(), sessionId: z.string().nullable() });
export type AccountSecurity = z.infer<typeof SecuritySchema>;

export function fetchMe(token: string): Promise<SessionUser> {
  return api.get('/v1/auth/me', SessionUserSchema, { token });
}

export function fetchSetupStatus(): Promise<SetupStatus> {
  return api.get('/v1/setup/status', SetupStatus, { token: null });
}

export function completeSetup(input: SetupRequest): Promise<void> {
  return api.command('POST', '/v1/setup', input, { token: null });
}

/** Break-glass recovery (POST /v1/setup/recover). */
export function recoverAccount(input: { recoveryToken: string; email: string; newPassword: string }): Promise<void> {
  return api.command('POST', '/v1/setup/recover', input, { token: null });
}

/** GET /v1/auth/security — whether the user has a password and where they stand on MFA. */
export function fetchSecurity(): Promise<AccountSecurity> {
  return api.get('/v1/auth/security', SecuritySchema);
}
