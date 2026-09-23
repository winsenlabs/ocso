import { eq, inArray } from 'drizzle-orm';
import { validation } from '@ocso/domain';
import { authAccounts, authPasskeys, teamMembers, teams, users, type DbOrTx } from '@ocso/db';
import { recordAudit } from '../audit/audit.js';
import type { ActorContext } from '../shared/context.js';
import { revokeUserSessions } from './credentials.js';
import { assertBreakGlassRemains } from './permissions/apply.js';

/** Profile fields of a user: never rights, so never gated. */
export interface UserProfilePatch {
  name?: string | undefined;
  languages?: string[] | undefined;
  skills?: string[] | undefined;
  maxConcurrent?: number | undefined;
}

export function profileOf(input: UserProfilePatch): UserProfilePatch {
  return {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.languages !== undefined ? { languages: input.languages } : {}),
    ...(input.skills !== undefined ? { skills: input.skills } : {}),
    ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
  };
}

export async function writeProfile(tx: DbOrTx, actor: ActorContext, id: string, email: string, profile: UserProfilePatch): Promise<void> {
  await tx.update(users).set({ ...profile, updatedAt: new Date() }).where(eq(users.id, id));
  await recordAudit(tx, actor, { action: 'user.update', targetType: 'user', targetId: id, summary: `Updated ${email}`, after: profile });
}

/** A stop: never gated. Ends every session at once (open streams close within a minute). */
export async function disableUser(tx: DbOrTx, actor: ActorContext, id: string, email: string, breakGlass: boolean): Promise<void> {
  if (breakGlass) await assertBreakGlassRemains(tx, id);
  await tx.update(users).set({ status: 'DISABLED', updatedAt: new Date() }).where(eq(users.id, id));
  const revoked = await revokeUserSessions(tx, id);
  await recordAudit(tx, actor, {
    action: 'user.disable',
    targetType: 'user',
    targetId: id,
    summary: `Disabled ${email}${revoked ? ` · ended ${revoked} session(s)` : ''}`,
  });
}

export async function hasSignInMethod(db: DbOrTx, userId: string): Promise<boolean> {
  const [account] = await db.select({ id: authAccounts.id }).from(authAccounts).where(eq(authAccounts.userId, userId)).limit(1);
  if (account) return true;
  const [passkey] = await db.select({ id: authPasskeys.id }).from(authPasskeys).where(eq(authPasskeys.userId, userId)).limit(1);
  return Boolean(passkey);
}

export async function addTeams(tx: DbOrTx, userId: string, teamIds: readonly string[]): Promise<void> {
  if (!teamIds.length) return;
  const found = await tx.select({ id: teams.id }).from(teams).where(inArray(teams.id, [...teamIds]));
  if (found.length !== teamIds.length) throw validation('unknown_team', 'One or more teams do not exist');
  await tx.insert(teamMembers).values(teamIds.map((teamId) => ({ teamId, userId })));
}
