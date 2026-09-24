import { SLACK_IDENTITY } from './capabilities.js';

/**
 * Slack users are `slack_user` identities valued `<team_id>:<user_id>`
 * (`T0123ABCD:U0456EFGH`): user ids are unique only within a workspace (or an
 * Enterprise Grid org, whose ids start with E and whose users start with W).
 */

const TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;
const USER_ID = /^[UW][A-Z0-9]{2,30}$/;

export function slackIdentityValue(teamId: string, userId: string): string | null {
  return TEAM_ID.test(teamId) && USER_ID.test(userId) ? `${teamId}:${userId}` : null;
}

export function parseSlackIdentity(value: string): { teamId: string; userId: string } | null {
  const [teamId, userId, extra] = value.split(':');
  if (extra !== undefined || !teamId || !userId || !TEAM_ID.test(teamId) || !USER_ID.test(userId)) return null;
  return { teamId, userId };
}

/** Lists show the Slack user id (never a name guessed from elsewhere); null for identity kinds that are not Slack's. */
export function displaySlackIdentity(identityKind: string, value: string): string | null {
  if (identityKind !== SLACK_IDENTITY) return null;
  const parsed = parseSlackIdentity(value);
  return parsed ? `slack · ${parsed.userId}` : 'slack · unknown user';
}
