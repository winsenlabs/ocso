import { sql } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import { DEFINITIONS, SettingsService, previousWindow, readableAgentsSql, windowOf, type AnalyticsWindow } from '@ocso/application';
import type { Db } from '@ocso/db';

/**
 * Escalation reasons over time (Lead "Escalation reasons" page, docs/11 §3).
 * Same population as `definitions.escalationReasons` — handoffs whose trigger is
 * not HUMAN_REQUEST on conversations of the agents the caller can read (a CS
 * Lead's teams' agents, ADR-026) opened inside the window — ranked, compared with the previous same-length window, split by
 * agent and routed queue, and bucketed per calendar day.
 */

export interface ReasonSplit {
  id: string | null;
  name: string | null;
  count: number;
}

export interface EscalationReasonTrend {
  reasonCode: string;
  trigger: string;
  count: number;
  /** Same reason/trigger in the previous same-length window. */
  previous: number;
  /** Most frequent free-text reason (agent/rule wording, never transcript text). */
  example: string | null;
  agents: ReasonSplit[];
  queues: ReasonSplit[];
}

export interface EscalationReasonsReport {
  window: { from: string; to: string; days: number; timezone: string };
  total: number;
  previousTotal: number;
  reasons: EscalationReasonTrend[];
  /** One entry per calendar day (deployment timezone) of the window, oldest first. */
  daily: Array<{ day: string; total: number; byReason: Record<string, number> }>;
  definitions: { reasons: string; previous: string; daily: string; split: string };
}

const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const cohort = (w: AnalyticsWindow) =>
  sql`c.agent_id IN (${w.scope ?? sql`SELECT id FROM virtual_agents`}) AND c.opened_at >= ${at(w.from)} AND c.opened_at < ${at(w.to)}`;
const int = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const key = (code: string, trigger: string) => `${code}\u0000${trigger}`;

export async function escalationReasonsReport(db: Db, principal: Principal, days: number, now: Date = new Date()): Promise<EscalationReasonsReport> {
  assertCan(principal, Permission.ANALYTICS_BUSINESS_READ);
  const { timezone } = await new SettingsService(db).deployment();
  const w = windowOf(null, days, now, timezone, readableAgentsSql(principal));
  const prev = previousWindow(w);

  const [current, previous, agents, queues, daily] = await Promise.all([
    db.execute<{ reason_code: string; trigger: string; n: number; example: string | null }>(sql`
      SELECT h.reason_code, h.trigger, count(*)::int AS n, mode() WITHIN GROUP (ORDER BY h.reason_text) AS example
        FROM conversations c
        JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
       WHERE ${cohort(w)}
       GROUP BY h.reason_code, h.trigger
       ORDER BY n DESC, h.reason_code
       LIMIT 50`),
    db.execute<{ reason_code: string; trigger: string; n: number }>(sql`
      SELECT h.reason_code, h.trigger, count(*)::int AS n
        FROM conversations c
        JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
       WHERE ${cohort(prev)}
       GROUP BY h.reason_code, h.trigger`),
    db.execute<{ reason_code: string; trigger: string; id: string; name: string; n: number }>(sql`
      SELECT h.reason_code, h.trigger, a.id, a.name, count(*)::int AS n
        FROM conversations c
        JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
        JOIN virtual_agents a ON a.id = c.agent_id
       WHERE ${cohort(w)}
       GROUP BY h.reason_code, h.trigger, a.id, a.name
       ORDER BY n DESC, a.name`),
    db.execute<{ reason_code: string; trigger: string; id: string | null; name: string | null; n: number }>(sql`
      SELECT h.reason_code, h.trigger, q.id, q.name, count(*)::int AS n
        FROM conversations c
        JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
        LEFT JOIN queues q ON q.id = h.queue_id
       WHERE ${cohort(w)}
       GROUP BY h.reason_code, h.trigger, q.id, q.name
       ORDER BY n DESC, q.name`),
    db.execute<{ day: string; reason_code: string | null; n: number }>(sql`
      WITH days AS (
        SELECT generate_series(date_trunc('day', ${at(w.from)} AT TIME ZONE ${timezone}),
                               date_trunc('day', ${at(w.to)} AT TIME ZONE ${timezone}),
                               interval '1 day') AS d
      )
      SELECT to_char(days.d, 'YYYY-MM-DD') AS day, h.reason_code, count(h.id)::int AS n
        FROM days
        LEFT JOIN conversations c
          ON ${cohort(w)}
         AND c.opened_at >= (days.d AT TIME ZONE ${timezone})
         AND c.opened_at < ((days.d + interval '1 day') AT TIME ZONE ${timezone})
        LEFT JOIN handoffs h ON h.conversation_id = c.id AND h.trigger <> 'HUMAN_REQUEST'
       GROUP BY days.d, h.reason_code
       ORDER BY days.d`),
  ]);

  const prevBy = new Map(previous.rows.map((r) => [key(r.reason_code, r.trigger), int(r.n)]));
  const split = (rows: Array<{ reason_code: string; trigger: string; id: string | null; name: string | null; n: number }>) => {
    const by = new Map<string, ReasonSplit[]>();
    for (const r of rows) {
      const k = key(r.reason_code, r.trigger);
      by.set(k, [...(by.get(k) ?? []), { id: r.id, name: r.name, count: int(r.n) }]);
    }
    return by;
  };
  const agentsBy = split(agents.rows);
  const queuesBy = split(queues.rows);

  const byDay = new Map<string, { day: string; total: number; byReason: Record<string, number> }>();
  for (const r of daily.rows) {
    const entry = byDay.get(r.day) ?? { day: r.day, total: 0, byReason: {} };
    if (r.reason_code) {
      entry.byReason[r.reason_code] = (entry.byReason[r.reason_code] ?? 0) + int(r.n);
      entry.total += int(r.n);
    }
    byDay.set(r.day, entry);
  }

  const reasons = current.rows.map((r): EscalationReasonTrend => {
    const k = key(r.reason_code, r.trigger);
    return {
      reasonCode: r.reason_code,
      trigger: r.trigger,
      count: int(r.n),
      previous: prevBy.get(k) ?? 0,
      example: r.example,
      agents: agentsBy.get(k) ?? [],
      queues: queuesBy.get(k) ?? [],
    };
  });

  return {
    window: { from: w.from.toISOString(), to: w.to.toISOString(), days, timezone },
    // From the daily buckets, which are not capped like the ranking (LIMIT 50).
    total: [...byDay.values()].reduce((s, d) => s + d.total, 0),
    previousTotal: previous.rows.reduce((s, r) => s + int(r.n), 0),
    reasons,
    daily: [...byDay.values()],
    definitions: {
      reasons: DEFINITIONS.escalationReasons,
      previous: 'The same grouping over the previous same-length window (conversations opened in the days immediately before this window).',
      daily: 'The same handoffs bucketed by the calendar day, in the deployment timezone, on which their conversation opened. The first day can be partial.',
      split: 'Per reason: handoffs by the virtual agent of the conversation, and by the queue the handoff was routed to (none = no queue).',
    },
  };
}
