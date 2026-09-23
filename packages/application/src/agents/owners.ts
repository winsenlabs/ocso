import { eq, inArray } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { forbidden, validation } from '@ocso/domain';
import { agentTeams, teams, type DbOrTx } from '@ocso/db';
import { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { emitEvent } from '../events/outbox.js';
import type { ActorContext } from '../shared/context.js';

export const OwnerTeamIds = z.array(z.uuid()).min(1, 'Choose at least one owning team').max(20);
export const AgentOwnersInput = z.object({ teamIds: OwnerTeamIds });
export type AgentOwnersInput = z.infer<typeof AgentOwnersInput>;

/**
 * Who may set which owning teams (ADR-026):
 * - agents.assign_owner (Tech admin, governance): any existing teams.
 * - agents.manage (Lead who is a member of an owning team): may add or
 *   remove only teams they belong to; owning teams they are not in stay as
 *   they are. Handing an agent off (removing every team of theirs) is allowed
 *   only while another team still owns it — they lose access afterwards.
 * - Always at least one owning team: nobody can orphan an agent.
 */
export type OwnerAuthority = 'ASSIGN_ANY' | 'OWN_TEAMS';

export function ownerAuthority(principal: Principal): OwnerAuthority {
  if (can(principal, Permission.AGENTS_ASSIGN_OWNER)) return 'ASSIGN_ANY';
  if (can(principal, Permission.AGENTS_MANAGE)) return 'OWN_TEAMS';
  throw forbidden(Permission.AGENTS_MANAGE, `role ${principal.role} cannot change owning teams`);
}

/** A new agent's owners: at least one, all of them teams the creating lead belongs to. */
export function assertNewOwners(principal: Principal, teamIds: readonly string[]): string[] {
  const unique = [...new Set(teamIds)];
  if (!unique.length) throw validation('owner_team_required', 'Choose at least one owning team');
  const foreign = unique.filter((t) => !principal.teamIds.includes(t));
  if (foreign.length) throw validation('owner_team_not_member', 'You can only choose teams you belong to as owners', { teamIds: foreign });
  return unique;
}

function assertLeadChange(principal: Principal, before: readonly string[], after: readonly string[]): void {
  const mine = new Set(principal.teamIds);
  const added = after.filter((t) => !before.includes(t));
  const removed = before.filter((t) => !after.includes(t));
  const foreignAdded = added.filter((t) => !mine.has(t));
  if (foreignAdded.length) throw validation('owner_team_not_member', 'You can only add teams you belong to as owners', { teamIds: foreignAdded });
  const foreignRemoved = removed.filter((t) => !mine.has(t));
  if (foreignRemoved.length) throw validation('owner_team_not_member', "You cannot remove another team's ownership", { teamIds: foreignRemoved });
}

async function teamNames(tx: DbOrTx, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const rows = await tx.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Replace an agent's owning teams inside the caller's transaction, enforcing
 * the rules above, and audit it (`agent.owners_change`). The caller has
 * already checked that the agent exists and is in the actor's scope.
 */
export async function replaceOwners(
  tx: DbOrTx,
  actor: ActorContext,
  agent: { id: string; name: string },
  requested: readonly string[],
  authority: OwnerAuthority,
): Promise<{ before: string[]; after: string[] }> {
  const after = [...new Set(requested)];
  if (!after.length) throw validation('owner_team_required', 'An agent needs at least one owning team');
  const before = (await tx.select({ teamId: agentTeams.teamId }).from(agentTeams).where(eq(agentTeams.agentId, agent.id))).map((r) => r.teamId);
  if (authority === 'OWN_TEAMS') assertLeadChange(actor.principal!, before, after);
  const names = await teamNames(tx, [...before, ...after]);
  const unknown = after.filter((t) => !names.has(t));
  if (unknown.length) throw validation('unknown_team', 'One or more teams do not exist', { teamIds: unknown });
  const same = before.length === after.length && before.every((t) => after.includes(t));
  if (same) return { before, after };

  await tx.delete(agentTeams).where(eq(agentTeams.agentId, agent.id));
  await tx.insert(agentTeams).values(after.map((teamId) => ({ agentId: agent.id, teamId })));
  const label = (ids: readonly string[]) => ids.map((t) => names.get(t) ?? t).sort().join(', ') || 'none';
  await recordAudit(tx, actor, {
    action: 'agent.owners_change',
    targetType: 'agent',
    targetId: agent.id,
    summary: `Owning teams of ${agent.name}: ${label(before)} → ${label(after)}${authority === 'ASSIGN_ANY' ? ' (reassigned by Tech admin)' : ''}`,
    before: { teamIds: before },
    after: { teamIds: after },
  });
  await emitEvent(tx, actor, 'config.changed', { area: 'agent_owners', entityId: agent.id }, { agentId: agent.id });
  return { before, after };
}
