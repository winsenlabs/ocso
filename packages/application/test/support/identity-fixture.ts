import type { Principal, Role, UserStatus } from '@ocso/auth';
import { authAccounts, teamMembers, teams, users, uuidv7, type Db } from '@ocso/db';
import { loadPrincipal, type ActorContext } from '../../src/index.js';

/** People written straight to the database, and principals loaded the way requests load them. */
export async function addTeam(db: Db, name: string): Promise<string> {
  const id = uuidv7();
  await db.insert(teams).values({ id, name });
  return id;
}

export async function addPerson(db: Db, input: { name: string; role: Role; teamIds?: string[]; status?: UserStatus; password?: boolean }): Promise<string> {
  const id = uuidv7();
  await db.insert(users).values({ id, email: `${input.name.toLowerCase().replace(/\W+/g, '.')}@perms.test`, name: input.name, role: input.role, status: input.status ?? 'ACTIVE', emailVerified: true });
  if (input.teamIds?.length) await db.insert(teamMembers).values(input.teamIds.map((teamId) => ({ teamId, userId: id })));
  // A credential account (the hash is never checked here): break-glass counts Tech admins with password sign-in.
  if (input.password) await db.insert(authAccounts).values({ id: uuidv7(), accountId: id, providerId: 'credential', userId: id, password: 'scrypt$x' });
  return id;
}

export async function principalOf(db: Db, userId: string): Promise<Principal> {
  const principal = await loadPrincipal(db, userId, 'UI');
  if (!principal) throw new Error(`${userId} is not active`);
  return principal;
}

export async function actorOf(db: Db, userId: string): Promise<ActorContext> {
  return { principal: await principalOf(db, userId), correlationId: 'perms-test' };
}
