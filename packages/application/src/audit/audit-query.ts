import { and, desc, eq, gte, ilike, lt, sql, type SQL } from 'drizzle-orm';
import { auditEvents, type Db } from '@ocso/db';
import { z } from 'zod';

export const AuditQuery = z.object({
  targetType: z.string().max(60).optional(),
  targetId: z.string().max(100).optional(),
  actorId: z.string().max(100).optional(),
  via: z.enum(['UI', 'API', 'INTERNAL_AGENT', 'SYSTEM']).optional(),
  action: z.string().max(100).optional(),
  since: z.iso.datetime().optional(),
  before: z.iso.datetime().optional(),
  /** With `before`: the id of the last row already shown, so rows sharing its timestamp are not skipped. */
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type AuditQuery = z.infer<typeof AuditQuery>;

/** Read-only audit log (docs/15 §7). Rows are immutable by database trigger. `scope` limits what the reader may see (see audit-scope.ts). */
export async function queryAudit(db: Db, q: AuditQuery, scope: SQL | null = null) {
  const filters: SQL[] = [];
  if (scope) filters.push(scope);
  if (q.targetType) filters.push(eq(auditEvents.targetType, q.targetType));
  if (q.targetId) filters.push(eq(auditEvents.targetId, q.targetId));
  if (q.actorId) filters.push(eq(auditEvents.actorId, q.actorId));
  if (q.via) filters.push(eq(auditEvents.via, q.via));
  if (q.action) filters.push(ilike(auditEvents.action, `${q.action.replace(/[%_\\]/g, '')}%`));
  if (q.since) filters.push(gte(auditEvents.occurredAt, new Date(q.since)));
  if (q.before && q.beforeId) filters.push(sql`(${auditEvents.occurredAt}, ${auditEvents.id}) < (${new Date(q.before)}, ${q.beforeId})`);
  else if (q.before) filters.push(lt(auditEvents.occurredAt, new Date(q.before)));
  return db.select().from(auditEvents).where(and(...filters)).orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id)).limit(q.limit);
}
