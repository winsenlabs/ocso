import { agentTeams, teams, uuidv7, type DbOrTx } from '@ocso/db';

/**
 * Test helpers for team-scoped agent ownership (ADR-026): Leads reach
 * agents only through a team that owns them, so fixtures give leads a team
 * (principal.teamIds) and agents an owning team (agent_teams).
 */

/** Insert a team row with a known id (principals are built before the database exists). */
export async function createTeam(db: DbOrTx, id: string = uuidv7(), name = `Team ${id.slice(-6)}`): Promise<string> {
  await db.insert(teams).values({ id, name }).onConflictDoNothing();
  return id;
}

/** Make `teamId` an owner of each agent. */
export async function ownAgents(db: DbOrTx, teamId: string, ...agentIds: string[]): Promise<void> {
  if (agentIds.length) await db.insert(agentTeams).values(agentIds.map((agentId) => ({ agentId, teamId }))).onConflictDoNothing();
}
