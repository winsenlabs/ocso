import { sql } from 'drizzle-orm';
import type { DbOrTx } from '@ocso/db';
import { cohortWhere, int, type AnalyticsWindow } from './values.js';

export interface TagCountRow {
  tag: string;
  count: number;
}

/** Most used staff tags on cohort conversations (definitions.tags). */
export async function topTags(db: DbOrTx, w: AnalyticsWindow, limit = 10): Promise<{ tagged: number; items: TagCountRow[] }> {
  const [counts, tagged] = await Promise.all([
    db.execute<{ tag: string; n: number }>(sql`
      SELECT t.tag, count(*)::int AS n
        FROM conversations c CROSS JOIN LATERAL unnest(c.tags) AS t(tag)
       WHERE ${cohortWhere(w)}
       GROUP BY t.tag
       ORDER BY n DESC, t.tag
       LIMIT ${limit}`),
    db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM conversations c WHERE ${cohortWhere(w)} AND cardinality(c.tags) > 0`),
  ]);
  return { tagged: int(tagged.rows[0]?.n), items: counts.rows.map((r) => ({ tag: r.tag, count: int(r.n) })) };
}
