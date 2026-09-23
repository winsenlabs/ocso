import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { iso } from '../analytics/values.js';

/** Platform (control-plane) audit target types shown to the Tech admin. Conversation/business operations are excluded. */
export const PLATFORM_AUDIT_TARGETS = [
  'worker_settings',
  'deployment',
  'model_provider',
  'model_profile',
  'model_pricing',
  'mcp_connection',
  'channel',
  'user',
  'team',
  'alert_rule',
  'notification_destination',
  'webhook_subscription',
  'secret',
] as const;

export interface PrivilegedChange {
  id: string;
  occurredAt: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  via: string;
  correlationId: string | null;
}

/**
 * Recent privileged configuration changes (design/03 & design/06 admin home)
 * from the immutable audit log. Only summaries and actors — before/after
 * payloads stay behind the audit API.
 */
export async function privilegedChanges(db: DbOrTx, limit = 20): Promise<PrivilegedChange[]> {
  const targets = sql.join(PLATFORM_AUDIT_TARGETS.map((t) => sql`${t}`), sql`, `);
  const { rows } = await db.execute<{
    id: string; occurred_at: Date; action: string; target_type: string; target_id: string | null; summary: string;
    actor_type: string; actor_id: string | null; actor_name: string | null; via: string; correlation_id: string | null;
  }>(sql`
    SELECT id, occurred_at, action, target_type, target_id, summary, actor_type, actor_id, actor_name, via, correlation_id
      FROM audit_events
     WHERE target_type IN (${targets}) AND action NOT IN ('model_provider.test') AND action NOT LIKE 'auth.%'
     ORDER BY occurred_at DESC
     LIMIT ${limit}`);
  return rows.map((r) => ({
    id: r.id,
    occurredAt: iso(r.occurred_at)!,
    action: r.action,
    targetType: r.target_type,
    targetId: r.target_id,
    summary: r.summary,
    actorType: r.actor_type,
    actorId: r.actor_id,
    actorName: r.actor_name,
    via: r.via,
    correlationId: r.correlation_id,
  }));
}
