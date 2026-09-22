import 'server-only';
import { z } from 'zod';
import { api } from './client';

/** TeamView from GET /v1/teams. */
export const TeamSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;

export function listTeams(): Promise<Team[]> {
  return api.get('/v1/teams', z.array(TeamSchema));
}

export function createTeam(input: { name: string; description: string | null }): Promise<Team> {
  return api.post('/v1/teams', input, TeamSchema);
}

/** Names of the given teams, in directory order. */
export function teamNames(teams: readonly Team[], ids: readonly string[]): string[] {
  const wanted = new Set(ids);
  return teams.filter((t) => wanted.has(t.id)).map((t) => t.name);
}
