import type { ApiHarness } from './harness.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

/**
 * Team fixtures for team-scoped agent ownership (ADR-026): a Lead creates
 * the team (teams.manage) and the Tech admin puts people in it (a lead cannot
 * change their own memberships). Memberships are read on every request, so
 * existing tokens pick them up.
 */
export async function createTeam(h: ApiHarness, leadToken: string, name: string): Promise<string> {
  return (await h.http().post('/v1/teams').set(auth(leadToken)).send({ name }).expect(201)).body.id as string;
}

export async function setTeams(h: ApiHarness, adminToken: string, userId: string, teamIds: string[]): Promise<void> {
  await h.http().patch(`/v1/users/${userId}`).set(auth(adminToken)).send({ teamIds }).expect(200);
}

/** A team with the given people in it; returns the team id. */
export async function teamOf(h: ApiHarness, tokens: { admin: string; lead: string }, name: string, userIds: string[]): Promise<string> {
  const teamId = await createTeam(h, tokens.lead, name);
  for (const userId of userIds) await setTeams(h, tokens.admin, userId, [teamId]);
  return teamId;
}
