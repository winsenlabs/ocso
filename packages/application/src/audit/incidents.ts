import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { auditIncidents, uuidv7, type AuditIncidentKind, type DbOrTx } from '@ocso/db';

export type AuditIncident = typeof auditIncidents.$inferSelect;

/**
 * Audit shipping and integrity incidents (ADR-032): one open row per kind,
 * `count` and `last_seen` bumped while the problem recurs, `detail` the latest
 * occurrence. The exception report (`audit_shipping`, `audit_chain`) and the
 * System screen read them. Never contains a secret: details are counts, ids,
 * error codes and short driver messages.
 */
export async function recordAuditIncident(db: DbOrTx, kind: AuditIncidentKind, detail: Record<string, unknown>): Promise<void> {
  await db.execute(sql`
    INSERT INTO audit_incidents (id, kind, detail) VALUES (${uuidv7()}, ${kind}, ${JSON.stringify(detail)}::jsonb)
    ON CONFLICT (kind) WHERE resolved_at IS NULL
    DO UPDATE SET last_seen = now(), count = audit_incidents.count + 1, detail = EXCLUDED.detail`);
}

/** Closes the open incidents of these kinds (the condition cleared). */
export async function resolveAuditIncidents(db: DbOrTx, kinds: readonly AuditIncidentKind[]): Promise<number> {
  const rows = await db
    .update(auditIncidents)
    .set({ resolvedAt: new Date() })
    .where(and(inArray(auditIncidents.kind, [...kinds]), isNull(auditIncidents.resolvedAt)))
    .returning({ id: auditIncidents.id });
  return rows.length;
}

export async function listAuditIncidents(db: DbOrTx, options: { openOnly?: boolean; limit?: number } = {}): Promise<AuditIncident[]> {
  return db
    .select()
    .from(auditIncidents)
    .where(options.openOnly ? isNull(auditIncidents.resolvedAt) : undefined)
    .orderBy(desc(auditIncidents.lastSeen))
    .limit(options.limit ?? 50);
}

export async function openAuditIncident(db: DbOrTx, kind: AuditIncidentKind): Promise<AuditIncident | null> {
  const [row] = await db.select().from(auditIncidents).where(and(eq(auditIncidents.kind, kind), isNull(auditIncidents.resolvedAt)));
  return row ?? null;
}
