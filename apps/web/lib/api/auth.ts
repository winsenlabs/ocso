import 'server-only';
import { ROLES } from '@ocso/auth';
import { z } from 'zod';
import { api } from './client';

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
});
export type SessionUser = z.infer<typeof SessionUserSchema>;

const LoginResponse = z.object({ token: z.string().min(1), expiresAt: z.string(), user: SessionUserSchema });
export type LoginResponse = z.infer<typeof LoginResponse>;

const SetupStatus = z.object({ setupRequired: z.boolean(), orgName: z.string() });
export type SetupStatus = z.infer<typeof SetupStatus>;

export interface SetupRequest {
  setupToken: string;
  orgName: string;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
  timezone: string;
}

export function fetchMe(token: string): Promise<SessionUser> {
  return api.get('/v1/auth/me', SessionUserSchema, { token });
}

/** `clientIp` is the proxy-verified browser address; the API uses it for per-address throttling and the audit trail. */
export function login(email: string, password: string, clientIp?: string): Promise<LoginResponse> {
  return api.post('/v1/auth/login', { email, password }, LoginResponse, { token: null, ...(clientIp ? { headers: { 'x-ocso-client-ip': clientIp } } : {}) });
}

export function logout(token: string): Promise<void> {
  return api.command('POST', '/v1/auth/logout', undefined, { token });
}

export function fetchSetupStatus(): Promise<SetupStatus> {
  return api.get('/v1/setup/status', SetupStatus, { token: null });
}

export function completeSetup(input: SetupRequest): Promise<void> {
  return api.command('POST', '/v1/setup', input, { token: null });
}
