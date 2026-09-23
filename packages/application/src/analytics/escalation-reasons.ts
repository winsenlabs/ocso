import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { cohortWhere, int, type AnalyticsWindow } from './values.js';

export interface EscalationReason {
  reasonCode: string;
  trigger: string;
  count: number;
  /** Most frequent free-text reason for this code (agent/rule wording, never transcript text). */
  example: string | null;
}

/** Top escalation reasons (definitions.escalationReasons), cohort → handoffs_conversation_idx. */
export async function escalationReasons(db: DbOrTx, w: AnalyticsWindow, limit = 10): Promise<{ total: number; reasons: EscalationReason[] }> {
  const { rows } = await db.execute<{ reason_code: string; trigger: string; n: number; example: string | null; total: number }>(sql`
    SELECT h.reason_code, h.trigger, count(*)::int AS n,
           mode() WITHIN GROUP (ORDER BY h.reason_text) AS example,
           (sum(count(*)) OVER ())::int AS total
      FROM conversations c
      JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
     WHERE ${cohortWhere(w)}
     GROUP BY h.reason_code, h.trigger
     ORDER BY n DESC, h.reason_code
     LIMIT ${limit}`);
  return {
    total: int(rows[0]?.total),
    reasons: rows.map((r) => ({ reasonCode: r.reason_code, trigger: r.trigger, count: int(r.n), example: r.example })),
  };
}
