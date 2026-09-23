import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * Immutable audit log (GET /v1/audit, docs/15 §7). Rows are append-only in the
 * database; payloads were redacted when written (packages/tools sanitizeForAudit).
 */

export const AUDIT_VIA = ['UI', 'API', 'INTERNAL_AGENT', 'SYSTEM'] as const;
export type AuditVia = (typeof AUDIT_VIA)[number];

export const AuditEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  via: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string().nullable(),
  summary: z.string(),
  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),
  correlationId: z.string().nullable(),
  confirmation: z.unknown().nullable().default(null),
  ip: z.string().nullable().default(null),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export interface AuditFilter {
  targetType?: string | undefined;
  targetId?: string | undefined;
  actorId?: string | undefined;
  via?: AuditVia | undefined;
  /** Prefix match on the action, e.g. "alert_rule." */
  action?: string | undefined;
  since?: string | undefined;
  before?: string | undefined;
  beforeId?: string | undefined;
  limit?: number | undefined;
}

export function auditQuery(filter: AuditFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value !== undefined && value !== '') params.set(key, String(value));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export const listAudit = (filter: AuditFilter = {}) => api.get(`/v1/audit${auditQuery(filter)}`, z.array(AuditEventSchema));

/**
 * The same read, plus where it came from: `store` (the audit store merged with
 * events not shipped yet) or `local` (the store did not answer; only the main
 * database's local window, so older events may be missing).
 */
export async function readAuditLog(filter: AuditFilter = {}): Promise<{ rows: AuditEvent[]; source: 'store' | 'local' }> {
  const { data, headers } = await api.getWithHeaders(`/v1/audit${auditQuery(filter)}`, z.array(AuditEventSchema));
  return { rows: data, source: headers.get('x-ocso-audit-source') === 'local' ? 'local' : 'store' };
}
