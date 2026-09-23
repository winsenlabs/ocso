import 'server-only';
import { ROLES } from '@ocso/auth';
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

/** TeamDetail from GET /v1/teams/:id (users.read): members with role, availability and join date. */
export const TeamMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: z.enum(ROLES),
  status: z.enum(['ACTIVE', 'DISABLED', 'PENDING_APPROVAL']),
  availability: z.enum(['AVAILABLE', 'AWAY', 'OFFLINE']),
  addedAt: z.string(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export const TeamDetailSchema = TeamSchema.extend({ createdAt: z.string(), members: z.array(TeamMemberSchema) });
export type TeamDetail = z.infer<typeof TeamDetailSchema>;

const teamPath = (id: string) => `/v1/teams/${encodeURIComponent(id)}`;

export function listTeams(): Promise<Team[]> {
  return api.get('/v1/teams', z.array(TeamSchema));
}

export function createTeam(input: { name: string; description: string | null }): Promise<Team> {
  return api.post('/v1/teams', input, TeamSchema);
}

export function getTeam(id: string): Promise<TeamDetail> {
  return api.get(teamPath(id), TeamDetailSchema);
}

/** PATCH /v1/teams/:id — Leads, on teams they belong to. */
export function updateTeam(id: string, input: { name: string; description: string | null }): Promise<void> {
  return api.command('PATCH', teamPath(id), input);
}

/** Tech admin: anyone. Lead: Service members and themselves, on teams they belong to (the API enforces it). */
export function addTeamMember(teamId: string, userId: string): Promise<void> {
  return api.command('POST', `${teamPath(teamId)}/members`, { userId });
}

export function removeTeamMember(teamId: string, userId: string): Promise<void> {
  return api.command('DELETE', `${teamPath(teamId)}/members/${encodeURIComponent(userId)}`);
}

/**
 * What a team is bound to, for the team drawer and membership consequences:
 * agents it owns (GET /v1/agents: only agents visible to the viewer, ADR-026)
 * and queues it serves (GET /v1/queues). Only the fields used here.
 */
const TeamBoundAgentSchema = z.object({ id: z.string(), name: z.string(), status: z.enum(['DRAFT', 'LIVE', 'PAUSED']), teams: z.array(z.object({ id: z.string() })) });
const TeamBoundQueueSchema = z.object({ id: z.string(), name: z.string(), teamIds: z.array(z.string()) });
export interface TeamBoundAgent {
  id: string;
  name: string;
  status: 'DRAFT' | 'LIVE' | 'PAUSED';
  teamIds: string[];
}
export interface TeamBoundQueue {
  id: string;
  name: string;
  teamIds: string[];
}

export async function listTeamBoundAgents(): Promise<TeamBoundAgent[]> {
  const agents = await api.get('/v1/agents', z.array(TeamBoundAgentSchema));
  return agents.map((a) => ({ id: a.id, name: a.name, status: a.status, teamIds: a.teams.map((t) => t.id) }));
}

export function listTeamBoundQueues(): Promise<TeamBoundQueue[]> {
  return api.get('/v1/queues', z.array(TeamBoundQueueSchema));
}
