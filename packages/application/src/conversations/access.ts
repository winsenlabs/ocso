import { and, eq, inArray, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { Permission, can, type Principal } from '@ocso/auth';
import { forbidden } from '@ocso/domain';
import { conversations, queueTeams, type DbOrTx } from '@ocso/db';

export interface VisibilityPolicy {
  /** Deployment setting: may CS Execs see conversations the AI is handling? */
  execsCanViewAiActive: boolean;
}

/**
 * Which conversations a principal may see (docs/09 §2, docs/15 §2).
 * - CS Lead: all conversations.
 * - CS Exec: conversations assigned to them, plus conversations in queues
 *   served by their teams (AI-active ones only when the deployment allows).
 * - Tech Admin: no conversation content (technical debugging uses traces/usage).
 * Returns null for "no restriction" and a SQL predicate otherwise.
 */
export function conversationScope(principal: Principal, policy: VisibilityPolicy): SQL | null {
  if (can(principal, Permission.CONVERSATIONS_READ_ALL)) return null;
  if (!can(principal, Permission.CONVERSATIONS_READ)) return sql`false`;
  const assigned = eq(conversations.assignedUserId, principal.userId);
  if (principal.teamIds.length === 0) return assigned;
  const teamQueues = sql`${conversations.queueId} IN (SELECT ${queueTeams.queueId} FROM ${queueTeams} WHERE ${inArray(queueTeams.teamId, [...principal.teamIds])})`;
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
