import { sql, type SQL } from 'drizzle-orm';
import { Permission, assertCan, type Principal } from '@ocso/auth';
import type { Db } from '@ocso/db';
import { queuesServedBy, readableAgentsSql } from '../agents/access.js';
import { QueueService } from '../routing/queues.js';
import { DEFINITIONS } from './definitions.js';
import { at, cohortWhere, int, num, windowOf } from './values.js';

export type QueueState = 'ok' | 'watch' | 'understaffed';

export interface QueueAnalyticsRow {
  queueId: string;
  name: string;
  mode: string;
  waiting: number;
  oldestWaitingSince: string | null;
  onShift: number;
  members: number;
  /** Conversations waiting past their SLA right now. */
  breaches: number;
  /** Cohort SLA breaches in the window (definitions.slaBreaches). */
  slaBreachesInWindow: number;
  avgWaitSeconds: number | null;
  pickedUp: number;
  state: QueueState;
}

/** Explicit queue state rule (definitions.queueState). */
export function queueState(q: { waiting: number; onShift: number; breaches: number }): QueueState {
  if (q.waiting > 0 && q.onShift < q.waiting) return 'understaffed';
  if (q.breaches > 0) return 'watch';
  return 'ok';
}

/**
 * Per-queue workload and staffing (design/06 lead Queues table). For a
 * principal scoped to their teams' agents (ADR-026) the rows are the queues
 * their teams serve or their agents route to, and the window metrics count
 * only their agents' conversations; the live columns (waiting, on shift) are
 * the queue's own.
 */
export class QueueAnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(principal: Principal, days = 7): Promise<{ window: { from: string; to: string; days: number }; queues: QueueAnalyticsRow[]; definitions: Record<string, string> }> {
    assertCan(principal, Permission.ANALYTICS_BUSINESS_READ);
    return this.compute(principal, days);
  }

  /** Same as list() without the permission check, for composed read models (home). */
  async compute(principal: Principal, days = 7) {
    const now = this.now();
    const scope = readableAgentsSql(principal);
    const w = windowOf(null, days, now, 'UTC', scope);
    const [queues, waits, breaches, relevant] = await Promise.all([
      new QueueService(this.db).list(),
      this.db.execute<{ queue_id: string; avg_wait: number | null; n: number }>(sql`
        SELECT h.queue_id, avg(extract(epoch FROM h.accepted_at - h.requested_at))::float8 AS avg_wait, count(*)::int AS n
          FROM conversations c
          JOIN handoffs h ON h.conversation_id = c.id
         WHERE ${cohortWhere(w)} AND h.queue_id IS NOT NULL AND h.accepted_at IS NOT NULL AND h.trigger <> 'HUMAN_REQUEST'
         GROUP BY h.queue_id`),
      this.db.execute<{ queue_id: string; n: number }>(sql`
        SELECT c.queue_id, count(*)::int AS n
          FROM conversations c
         WHERE ${cohortWhere(w)} AND c.queue_id IS NOT NULL
           AND ((c.control_state IN ('ESCALATION_REQUESTED', 'WAITING_FOR_HUMAN') AND c.sla_due_at < ${at(now)})
                OR c.first_human_response_at > c.sla_due_at)
         GROUP BY c.queue_id`),
      scope ? this.relevantQueues(principal, scope, w.from) : Promise.resolve(null),
    ]);
    const waitBy = new Map(waits.rows.map((r) => [r.queue_id, r]));
    const breachBy = new Map(breaches.rows.map((r) => [r.queue_id, int(r.n)]));
    return {
      window: { from: w.from.toISOString(), to: w.to.toISOString(), days },
      queues: queues.filter((q) => !relevant || relevant.has(q.id)).map((q): QueueAnalyticsRow => {
        const wait = waitBy.get(q.id);
        const avg = num(wait?.avg_wait);
        return {
          queueId: q.id,
          name: q.name,
          mode: q.mode,
          waiting: q.waiting,
          oldestWaitingSince: q.oldestWaitingSince,
          onShift: q.onShift,
          members: q.members,
          breaches: q.breaches,
          slaBreachesInWindow: breachBy.get(q.id) ?? 0,
          avgWaitSeconds: avg === null ? null : Math.round(avg),
          pickedUp: int(wait?.n),
          state: queueState(q),
        };
      }),
      definitions: { avgWaitSeconds: DEFINITIONS.queueAvgWait, state: DEFINITIONS.queueState, slaBreachesInWindow: DEFINITIONS.slaBreaches },
    };
  }

  /**
   * Queues served by the principal's teams, or that their agents route to:
   * default queue, escalation rule target, or the queue of one of their
   * agents' conversations that is open now or opened inside the window.
   */
  private async relevantQueues(principal: Principal, scope: SQL, from: Date): Promise<Set<string>> {
    const { rows } = await this.db.execute<{ id: string }>(sql`
      SELECT q.id FROM queues q
       WHERE q.id IN (${queuesServedBy(principal.teamIds)})
          OR q.id IN (SELECT default_queue_id FROM virtual_agents WHERE id IN (${scope}))
          OR q.id IN (SELECT target_queue_id FROM escalation_rules WHERE agent_id IN (${scope}))
          OR q.id IN (SELECT queue_id FROM conversations
                       WHERE agent_id IN (${scope}) AND (control_state <> 'RESOLVED' OR opened_at >= ${at(from)}))`);
    return new Set(rows.map((r) => r.id));
  }
}
