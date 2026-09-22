import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';

/**
 * Small value helpers shared by the analytics and telemetry read models.
 * Raw `db.execute` rows return bigint/numeric as strings, so every number is
 * normalized here; `null` always means "no data", never zero.
 */

export const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export const int = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
export const rounded = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};
export const iso = (v: unknown): string | null => (v === null || v === undefined ? null : new Date(v as string | Date).toISOString());

/** Timestamp parameter with an explicit type (overloaded SQL functions need it). */
export const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** Restrict a raw `agent_id` column to one agent, or to all virtual agents (keeps the (agent_id, …) indexes usable). */
export const agentClause = (column: SQL, agentId: string | null): SQL =>
  agentId ? sql`${column} = ${agentId}::uuid` : sql`${column} IN (SELECT id FROM virtual_agents)`;

/** Normalized grouping key for free-text classifier labels (case/whitespace-insensitive). */
export const labelKey = (column: SQL): SQL => sql`lower(regexp_replace(trim(${column}), '[[:space:]]+', ' ', 'g'))`;

/** Start of the calendar day containing `now` in the deployment timezone. */
export async function startOfDay(db: DbOrTx, now: Date, timezone: string): Promise<Date> {
  const { rows } = await db.execute<{ start: Date | string }>(
    sql`SELECT (date_trunc('day', ${at(now)} AT TIME ZONE ${timezone}) AT TIME ZONE ${timezone}) AS start`,
  );
  return new Date(rows[0]!.start);
}

export interface AnalyticsWindow {
  /** null = every virtual agent. */
  agentId: string | null;
  from: Date;
  to: Date;
  days: number;
  timezone: string;
}

export function windowOf(agentId: string | null, days: number, now: Date, timezone: string): AnalyticsWindow {
  return { agentId, from: new Date(now.getTime() - days * 86_400_000), to: now, days, timezone };
}

/** The same-length window immediately before `w` (for deltas). */
export function previousWindow(w: AnalyticsWindow): AnalyticsWindow {
  return { ...w, from: new Date(w.from.getTime() - w.days * 86_400_000), to: w.from };
}

/**
 * Cohort predicate: conversations of the scoped agent(s) opened inside the
 * window. Every conversation-based KPI uses this population.
 */
export const cohortWhere = (w: AnalyticsWindow, alias = sql`c`): SQL =>
  sql`${agentClause(sql`${alias}.agent_id`, w.agentId)} AND ${alias}.opened_at >= ${at(w.from)} AND ${alias}.opened_at < ${at(w.to)}`;
