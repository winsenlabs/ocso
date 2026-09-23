import { sql, type SQL } from 'drizzle-orm';
import { fingerprint, formatWindow, type AlertScope } from '@ocso/alerts';
import type { DbOrTx } from '@ocso/db';
import type { EvaluationContext, Observation } from './contract.js';

/** Shared helpers for evaluator SQL. Evaluators pass the evaluation `now`, never DB `now()`. */

export async function queryRows<T>(db: DbOrTx, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return result.rows as T[];
}

export const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

/** `AND <column> = <agentId>` when the rule is bound to one virtual agent. */
export function agentClause(column: SQL, agentId: string | null): SQL {
  return agentId ? sql` AND ${column} = ${agentId}::uuid` : sql``;
}

/** Postgres `IN (…)` list of text parameters. */
export function textList(values: readonly string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

export function windowPhrase(ctx: Pick<EvaluationContext<unknown>, 'rule'>): string {
  return `in the last ${formatWindow(ctx.rule.windowSeconds)}`;
}

export interface ObservationFields {
  firing: boolean;
  title: string;
  body: string;
  value: string;
  source: string;
  /** Virtual agent the observation is about (enables per-agent alert filtering). */
  agentId?: string | null | undefined;
  context?: Record<string, unknown> | undefined;
}

/** Build an observation whose fingerprint is derived from (rule, scope). */
export function observe(ctx: EvaluationContext<unknown>, scope: AlertScope, fields: ObservationFields): Observation {
  const agentId = fields.agentId ?? ctx.rule.agentId ?? null;
  return {
    fingerprint: fingerprint(ctx.rule.id, scope),
    firing: fields.firing,
    title: fields.title,
    body: fields.body,
    value: fields.value,
    source: fields.source,
    context: {
      windowSeconds: ctx.rule.windowSeconds,
      windowStart: ctx.window.start.toISOString(),
      windowEnd: ctx.window.end.toISOString(),
      scope,
      ...(agentId ? { agentId } : {}),
      ...fields.context,
    },
  };
}

/** Numbers from SQL aggregates (float8 arrives as number; numeric/bigint as string). */
export function num(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

export function numOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}
