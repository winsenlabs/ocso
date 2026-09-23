import { and, desc, eq, gte, isNull, like, lt, or, sql, type SQL } from 'drizzle-orm';
import { withTimeout, type AuditRecord, type AuditScopeFilter, type AuditStore, type AuditStoreQuery } from '@ocso/audit-store';
import { auditEvents, type Db } from '@ocso/db';
import { z } from 'zod';
import { auditScopeSql } from './audit-scope.js';

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

/** One audit event as the API serves it (the web's AuditEventSchema); team ids stay internal. */
export interface AuditEventView {
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorName: string | null;
  via: string;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  before: unknown;
  after: unknown;
  correlationId: string | null;
  confirmation: unknown;
  ip: string | null;
}

export interface AuditReadResult {
  rows: AuditEventView[];
  /** `store` = the audit store merged with not-yet-shipped outbox rows; `local` = the main database only (no store, or it failed). */
  source: 'store' | 'local';
}

const view = (r: AuditEventView): AuditEventView => ({
  id: r.id,
  occurredAt: r.occurredAt,
  actorType: r.actorType,
  actorId: r.actorId,
  actorName: r.actorName,
  via: r.via,
  action: r.action,
  targetType: r.targetType,
  targetId: r.targetId,
  summary: r.summary,
  before: r.before ?? null,
  after: r.after ?? null,
  correlationId: r.correlationId,
  confirmation: r.confirmation ?? null,
  ip: r.ip,
});

/** Newest first; ties on time by id (string order, as every store sorts). */
const newestFirst = (a: AuditEventView, b: AuditEventView) => b.occurredAt.getTime() - a.occurredAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function toStoreQuery(q: AuditQuery): AuditStoreQuery {
  const out: AuditStoreQuery = { limit: q.limit };
  if (q.targetType) out.targetType = q.targetType;
  if (q.targetId) out.targetId = q.targetId;
  if (q.actorId) out.actorId = q.actorId;
  if (q.via) out.via = q.via;
  if (q.action) out.actionPrefix = q.action;
  if (q.since) out.since = new Date(q.since);
  if (q.before && q.beforeId) out.before = { occurredAt: new Date(q.before), id: q.beforeId };
  else if (q.before) out.until = new Date(q.before);
  return out;
}

/** Filters over `audit_events`; times compare at millisecond precision, as the store keeps them. */
function localFilters(q: AuditQuery, scope: AuditScopeFilter): SQL[] {
  const at = sql`date_trunc('milliseconds', ${auditEvents.occurredAt})`;
  const filters: SQL[] = [];
  const scoped = auditScopeSql(scope);
  if (scoped) filters.push(scoped);
  if (q.targetType) filters.push(eq(auditEvents.targetType, q.targetType));
  if (q.targetId) filters.push(eq(auditEvents.targetId, q.targetId));
  if (q.actorId) filters.push(eq(auditEvents.actorId, q.actorId));
  if (q.via) filters.push(eq(auditEvents.via, q.via));
  if (q.action) filters.push(like(auditEvents.action, `${q.action.replace(/[%_\\]/g, (c) => `\\${c}`)}%`));
  if (q.since) filters.push(gte(auditEvents.occurredAt, new Date(q.since)));
  if (q.before && q.beforeId) filters.push(sql`(${at}, ${auditEvents.id}) < (${new Date(q.before)}, ${q.beforeId}::uuid)`);
  else if (q.before) filters.push(lt(auditEvents.occurredAt, new Date(q.before)));
  return filters;
}

/** How long a read waits for the store before answering from the local window. */
export const AUDIT_READ_TIMEOUT_MS = 5_000;

async function readLocal(db: Db, q: AuditQuery, scope: AuditScopeFilter, onlyUnshipped: boolean): Promise<AuditEventView[]> {
  const filters = localFilters(q, scope);
  // Not yet confirmed in the store: unshipped, or shipped but not verified (an append the store may have lost).
  if (onlyUnshipped) filters.push(or(isNull(auditEvents.shippedAt), isNull(auditEvents.verifiedAt))!);
  // Merged with the store, the (small) unshipped set must sort at millisecond precision like the store, or a
  // page could skip rows sharing a millisecond. The local-only read keeps the time index order.
  const time = onlyUnshipped ? sql`date_trunc('milliseconds', ${auditEvents.occurredAt})` : auditEvents.occurredAt;
  const rows = await db.select().from(auditEvents).where(and(...filters)).orderBy(desc(time), desc(auditEvents.id)).limit(q.limit);
  return rows.map(view);
}

/**
 * The audit log read (docs/15 §7, ADR-032): the audit store — the system of
 * record — merged with main-database rows not shipped yet, so the screen never
 * shows shipping lag. The outbox is read first: a row shipped between the two
 * reads is then already in the store; rows shipped but not yet verified are
 * merged too, so an append the store lost is not invisible until
 * reconciliation. Without a store (application tests, tools), or when the
 * store fails or does not answer within `timeoutMs`, the main database's local
 * window answers (`source: 'local'`; `onStoreError` hears why) — the web shows
 * a banner then.
 */
export async function readAudit(
  store: AuditStore | null,
  db: Db,
  q: AuditQuery,
  scope: AuditScopeFilter,
  onStoreError?: (err: unknown) => void,
  timeoutMs: number = AUDIT_READ_TIMEOUT_MS,
): Promise<AuditReadResult> {
  if (!store) return { rows: await readLocal(db, q, scope, false), source: 'local' };
  const pending = await readLocal(db, q, scope, true);
  let stored: AuditRecord[];
  try {
    stored = await withTimeout(store.query(toStoreQuery(q), scope), timeoutMs, 'the audit store');
  } catch (err) {
    onStoreError?.(err);
    return { rows: await readLocal(db, q, scope, false), source: 'local' };
  }
  const byId = new Map<string, AuditEventView>();
  for (const r of [...stored, ...pending]) if (!byId.has(r.id)) byId.set(r.id, view(r));
  return { rows: [...byId.values()].sort(newestFirst).slice(0, q.limit), source: 'store' };
}

/** readAudit's rows (the shape every reader had before the audit store). */
export async function queryAudit(store: AuditStore | null, db: Db, q: AuditQuery, scope: AuditScopeFilter, onStoreError?: (err: unknown) => void): Promise<AuditEventView[]> {
  return (await readAudit(store, db, q, scope, onStoreError)).rows;
}
