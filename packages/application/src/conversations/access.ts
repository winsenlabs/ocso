import { and, eq, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import { conversations, type DbOrTx } from '@ocso/db';
import { agentsOwnedBy, queuesServedBy } from '../agents/access.js';

export interface VisibilityPolicy {
  /** Deployment setting: may Service members see conversations the AI is handling? */
  execsCanViewAiActive: boolean;
}

/**
 * Which conversations a principal may see (docs/archive/specs/09 §2, docs/archive/specs/15 §2, ADR-026).
 * - conversations.read_team (Lead): conversations assigned to them, of
 *   virtual agents their teams own, or routed to queues their teams serve —
 *   in any control state; while a router still decides a conversation it
 *   opened (ROUTING, no agent or queue yet) also those whose router can route
 *   to such a queue or agent. Other teams' agents stay invisible.
 * - conversations.read (Service member): conversations assigned to them, plus
 *   conversations in queues served by their teams (AI-active ones only when
 *   the deployment allows).
 * - Neither (Tech admin): no conversation content (technical debugging uses
 *   traces/usage).
 * Returns a SQL predicate on `conversations`; every principal is scoped (the
 * `null` = unrestricted case is kept for callers but no role has it today).
 */
export function conversationScope(principal: Principal, policy: VisibilityPolicy): SQL | null {
  const assigned = eq(conversations.assignedUserId, principal.userId);
  if (can(principal, Permission.CONVERSATIONS_READ_TEAM)) {
    if (principal.teamIds.length === 0) return assigned;
    const owned = agentsOwnedBy(principal.teamIds);
    const served = queuesServedBy(principal.teamIds);
    return or(
      assigned,
      sql`${conversations.agentId} IN (${owned})`,
      sql`${conversations.queueId} IN (${served})`,
      // Only conversations the router itself opened (no agent yet): a returning customer's conversation keeps its history
      // and stays with its own agent's and queue's teams while they are asked continue-or-new.
      sql`(${conversations.controlState} = 'ROUTING' AND ${conversations.agentId} IS NULL AND ${conversations.id} IN (${routingReachableBy(owned, served)}))`,
    )!;
  }
  if (!can(principal, Permission.CONVERSATIONS_READ)) return sql`false`;
  if (principal.teamIds.length === 0) return assigned;
  const teamQueues = sql`${conversations.queueId} IN (${queuesServedBy(principal.teamIds)})`;
  const queueScope = policy.execsCanViewAiActive
    ? teamQueues
    : and(teamQueues, notInArray(conversations.controlState, ['AI_ACTIVE', 'AI_RESUMING']))!;
  return or(assigned, queueScope)!;
}

/** Throw unless the principal may see this conversation. */
export async function assertConversationAccess(
  db: DbOrTx,
  principal: Principal,
  conversationId: string,
  policy: VisibilityPolicy,
): Promise<void> {
  const scope = conversationScope(principal, policy);
  const where = scope ? and(eq(conversations.id, conversationId), scope) : eq(conversations.id, conversationId);
  const [row] = await db.select({ id: conversations.id }).from(conversations).where(where).limit(1);
  if (!row) throw forbidden('conversation', 'not permitted or not found');
}

/** Conversations a router opened and is deciding whose router can route to one of these queues or agents. */
function routingReachableBy(ownedAgents: SQL, servedQueues: SQL): SQL {
  return sql`SELECT cr.conversation_id FROM conversation_routing cr
    JOIN router_versions v ON v.id = cr.router_version_id
    WHERE cr.phase = 'STEPS' AND cr.seq_from = 0 AND EXISTS (
      SELECT 1 FROM queues q
       WHERE q.id::text IN (SELECT v.definition ->> 'fallbackQueueId' UNION ALL SELECT r ->> 'queueId' FROM jsonb_array_elements(COALESCE(v.definition -> 'rules', '[]'::jsonb)) AS r)
         AND (q.id IN (${servedQueues}) OR q.agent_id IN (${ownedAgents})))`;
}
