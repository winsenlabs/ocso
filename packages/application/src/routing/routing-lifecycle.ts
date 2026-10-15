import { sql } from 'drizzle-orm';
import { AI_IDLE_DEFAULT_HOURS, AI_IDLE_MAX_HOURS, AI_IDLE_SETTING, IDLE_DISPOSITION } from '@ocso/domain';
import type { Db } from '@ocso/db';
import { applyControl, lockConversation } from '../conversations/control.js';
import { emitEvent } from '../events/outbox.js';
import { systemActor } from '../shared/context.js';
import { loadActiveRouter } from './router-load.js';
import { rerouteIfStale } from './routing-admit.js';

const BATCH = 100;

/** A customer message the conversation's agent has not answered yet. */
const unanswered = sql`EXISTS (SELECT 1 FROM interactions i WHERE i.conversation_id = c.id AND i.actor_type = 'CUSTOMER' AND i.kind = 'MESSAGE' AND i.seq > c.last_processed_seq)`;

/**
 * Customers left waiting on an agent that stopped answering (paused, no model): routed again through the channel's
 * active router, or handed to a person on the queue when the channel has none. Returns the conversations now
 * routing, for the caller to signal.
 */
export async function rerouteStranded(db: Db, now: Date, correlationId: string): Promise<{ routing: string[]; handedOff: number }> {
  const { rows } = await db.execute<{ id: string }>(sql`
    SELECT c.id FROM conversations c JOIN virtual_agents a ON a.id = c.agent_id
     WHERE c.control_state = 'AI_ACTIVE' AND NOT (a.status = 'LIVE' AND a.model_profile_id IS NOT NULL) AND ${unanswered}
     ORDER BY c.last_interaction_at LIMIT ${BATCH}`);
  const routing: string[] = [];
  let handedOff = 0;
  for (const { id } of rows) {
    const outcome = await db.transaction(async (tx) => {
      const conv = await lockConversation(tx, id);
      const active = conv.channelId ? await loadActiveRouter(tx, conv.channelId) : null;
      return rerouteIfStale(tx, conv, active, now, correlationId);
    });
    if (outcome === 'ROUTE') routing.push(id);
    if (outcome === 'HUMAN') handedOff++;
  }
  return { routing, handedOff };
}

/**
 * AI-handled conversations quiet for longer than their channel's `aiIdleResolveHours` (default 24, 0 = never) are
 * resolved, so the customer's next message goes through the router again. Never one a person holds, and never one
 * with a customer message still unanswered.
 */
export async function resolveIdle(db: Db, now: Date, correlationId: string): Promise<number> {
  const hours = sql`COALESCE(CASE WHEN jsonb_typeof(ch.settings -> ${AI_IDLE_SETTING}) = 'number' THEN (ch.settings ->> ${AI_IDLE_SETTING})::numeric END, ${AI_IDLE_DEFAULT_HOURS})`;
  const { rows } = await db.execute<{ id: string; hours: string }>(sql`
    SELECT c.id, ${hours}::text AS hours FROM conversations c JOIN channels ch ON ch.id = c.channel_id
     WHERE c.control_state = 'AI_ACTIVE'
       AND ${hours} > 0 AND ${hours} <= ${AI_IDLE_MAX_HOURS} AND ${hours} = trunc(${hours})
       AND c.last_interaction_at < ${now.toISOString()}::timestamptz - make_interval(hours => (${hours})::int)
       AND NOT ${unanswered}
     ORDER BY c.last_interaction_at LIMIT ${BATCH}`);
  const actor = systemActor('idle-resolver', correlationId, 'Quiet conversations');
  let resolved = 0;
  for (const { id, hours: h } of rows) {
    const done = await db.transaction(async (tx) => {
      const conv = await lockConversation(tx, id);
      // Re-checked under the lock: the customer may have written, or a person taken over, since the scan.
      if (conv.controlState !== 'AI_ACTIVE' || conv.lastInteractionAt.getTime() >= now.getTime() - Number(h) * 3_600_000) return false;
      await applyControl(tx, id, {
        command: 'RESOLVE',
        actor,
        transitionActor: 'SYSTEM',
        description: `no messages for ${h} hours · resolved; the customer's next message goes through the router again`,
        patch: { resolvedAt: now, disposition: IDLE_DISPOSITION, waitingSince: null },
        now,
      });
      await emitEvent(tx, actor, 'conversation.resolved', { disposition: IDLE_DISPOSITION, resolvedBy: null }, { conversationId: id, agentId: conv.agentId });
      return true;
    });
    if (done) resolved++;
  }
  return resolved;
}
