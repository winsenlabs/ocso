/**
 * Teams identity namespace: `teams_user` = `<tenant id>:<Entra object id>`
 * (lower case). The object id (`from.aadObjectId`) is the person's stable id
 * across chats, teams and devices; the tenant keeps two organizations' users
 * apart. Staff lists show `Teams · …<last 6>` of the object id.
 */

export const TEAMS_IDENTITY = { USER: 'teams_user' } as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<tenant>:<object id>`, or null when either is not a GUID. */
export function teamsUserIdentity(tenantId: string | null | undefined, aadObjectId: string | null | undefined): string | null {
  if (!tenantId || !aadObjectId || !GUID.test(tenantId) || !GUID.test(aadObjectId)) return null;
  return `${tenantId.toLowerCase()}:${aadObjectId.toLowerCase()}`;
}

export function displayTeamsIdentity(identityKind: string, value: string): string | null {
  if (identityKind !== TEAMS_IDENTITY.USER) return null;
  const objectId = value.split(':')[1] ?? value;
  return `Teams · …${objectId.slice(-6)}`;
}
