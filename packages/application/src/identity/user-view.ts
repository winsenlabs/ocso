import type { Role, UserStatus } from '@ocso/auth';
import type { users } from '@ocso/db';

/**
 * none = created with a password (or by setup / SSO); pending/expired = an
 * invite link is outstanding; accepted = the invited user set up sign-in.
 */
export type InviteStatus = 'none' | 'pending' | 'expired' | 'accepted';

export interface UserView {
  id: string;
  email: string;
  name: string;
  role: Role;
  /** PENDING_APPROVAL: created, inert, cannot sign in until approved. */
  status: UserStatus;
  availability: 'AVAILABLE' | 'AWAY' | 'OFFLINE';
  maxConcurrent: number;
  languages: string[];
  skills: string[];
  teamIds: string[];
  lastLoginAt: string | null;
  invite: { status: InviteStatus; expiresAt: string | null };
  mfaEnabled: boolean;
}

export function inviteStatus(u: Pick<typeof users.$inferSelect, 'invitedAt' | 'inviteExpiresAt'>, now = new Date()): InviteStatus {
  if (!u.invitedAt) return 'none';
  if (!u.inviteExpiresAt) return 'accepted';
  return u.inviteExpiresAt.getTime() > now.getTime() ? 'pending' : 'expired';
}

export function toUserView(u: typeof users.$inferSelect, teamIds: string[], now = new Date()): UserView {
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
    invite: { status: inviteStatus(u, now), expiresAt: u.inviteExpiresAt?.toISOString() ?? null },
    mfaEnabled: u.twoFactorEnabled,
  };
}
