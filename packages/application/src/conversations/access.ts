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
 * Which conversations a principal may see (docs/09 §2, docs/15 §2, ADR-026).
 * - conversations.read_team (Lead): conversations assigned to them, of
 *   virtual agents their teams own, or routed to queues their teams serve —
 *   in any control state. Other teams' agents stay invisible.
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
    return or(
      assigned,
      sql`${conversations.agentId} IN (${agentsOwnedBy(principal.teamIds)})`,
      sql`${conversations.queueId} IN (${queuesServedBy(principal.teamIds)})`,
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
