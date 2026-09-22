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
});
export type User = z.infer<typeof UserSchema>;

export interface CreateUserRequest {
  name: string;
  email: string;
  role: Role;
  password: string;
  teamIds: string[];
  languages: string[];
  maxConcurrent: number;
}

export function listUsers(): Promise<User[]> {
  return api.get('/v1/users', z.array(UserSchema));
}

/** Tech Admin may create any role; a CS Lead only CS Execs (enforced by the API). */
export function createUser(input: CreateUserRequest): Promise<User> {
  return api.post('/v1/users', input, UserSchema);
}

export function setMyAvailability(availability: Availability): Promise<void> {
  return api.command('PUT', '/v1/me/availability', { availability });
}
