import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import type { ExceptionItem } from '../contract.js';

/** Rows of a raw query. */
export async function rows<T extends Record<string, unknown>>(db: DbOrTx, query: SQL): Promise<T[]> {
  return (await db.execute<T>(query)).rows as T[];
}

export const at = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;

export function isoOf(value: Date | string | null | undefined, fallback: Date): string {
  if (value === null || value === undefined) return fallback.toISOString();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

export function teamsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  // node-postgres returns uuid[] as '{a,b}' when the column type is not registered.
  if (typeof value === 'string' && value.startsWith('{')) return value.slice(1, -1).split(',').filter(Boolean);
  return [];
}

/** "3 h", "2 d 4 h": ages in a report are read by people. */
export function age(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48) return `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} d${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Defaulted = 'count' | 'teamIds' | 'href' | 'readableWith' | 'actorIds' | 'subjectIds';

export function item(fields: Omit<ExceptionItem, Defaulted> & Partial<Pick<ExceptionItem, Defaulted>>): ExceptionItem {
  return { href: null, teamIds: [], readableWith: null, actorIds: [], subjectIds: [], count: 1, ...fields };
}

/** Distinct non-null ids (actorIds / subjectIds). */
export const idsOf = (...values: Array<string | null | undefined>): string[] => [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];

/**
 * Runs one descriptor call in its own savepoint: a SQL error inside it rolls back only that savepoint, so
 * the rest of the check (and the report's read-only transaction) goes on. Resolves to `fallback` on error.
 */
export async function guarded<T>(db: DbOrTx, fallback: T, run: (sp: DbOrTx) => Promise<T>): Promise<T> {
  try {
    return await db.transaction((sp) => run(sp));
  } catch {
    return fallback;
  }
}

/** Link to one proposal in the approvals screen (its drawer). */
export const proposalHref = (id: string, open: boolean) => (open ? `/approvals?approval=${id}` : `/approvals?box=decided&approval=${id}`);
