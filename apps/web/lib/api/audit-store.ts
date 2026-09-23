import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * The audit store (ADR-032): GET /v1/audit/store (system.read or audit.verify)
 * and POST /v1/audit/verify (audit.verify). The store is a separate database;
 * the main one ships events to it and the worker seals them into a hash chain
 * with Ed25519-signed checkpoints.
 */

const at = z.string().nullable();

export const AuditStoreStatusSchema = z.object({
  driver: z.string(),
  status: z.enum(['OK', 'DEGRADED', 'DOWN']),
  health: z.object({ ok: z.boolean(), latencyMs: z.number(), detail: z.string().optional() }),
  lagSeconds: z.number(),
  unshipped: z.number(),
  unverified: z.number(),
  sealedPosition: z.number().nullable(),
  lastCheckpoint: z.object({ id: z.string(), upToPosition: z.number(), createdAt: z.string(), keyId: z.string() }).nullable(),
  store: z.object({ rows: z.number(), bytes: z.number().nullable(), oldest: at, newest: at }).nullable(),
  exports: z.object({
    count: z.number(),
    last: z.object({ fromPosition: z.number(), toPosition: z.number(), records: z.number(), manifestKey: z.string(), createdAt: z.string() }).nullable(),
  }),
  incidents: z.array(z.object({ id: z.string(), kind: z.string(), count: z.number(), firstSeen: z.string(), lastSeen: z.string(), detail: z.record(z.string(), z.unknown()) })),
  signingKey: z.object({ keyId: z.string(), retired: z.array(z.string()).default([]) }).nullable(),
  fullVerification: z.object({ finishedAt: z.string(), ok: z.boolean(), entries: z.number(), checkedTo: z.number(), problems: z.number() }).nullable().default(null),
  warnings: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type AuditStoreStatus = z.infer<typeof AuditStoreStatusSchema>;

export const AuditVerificationSchema = z.object({
  ok: z.boolean(),
  from: z.number(),
  to: z.number(),
  head: z.number().nullable(),
  entries: z.number(),
  records: z.number(),
  purged: z.number(),
  checkpoints: z.object({ checked: z.number(), valid: z.number() }),
  problems: z.array(z.object({ kind: z.string(), position: z.number(), recordId: z.string().optional(), detail: z.string() })),
  truncated: z.boolean(),
  verifiedAt: z.string(),
});
export type AuditVerification = z.infer<typeof AuditVerificationSchema>;

export const loadAuditStoreStatus = () => api.get('/v1/audit/store', AuditStoreStatusSchema);

/** Records that a chain break was investigated (audit.verify) — resolves the CHAIN_BROKEN incident; audited. */
export const acknowledgeChainBreak = (incidentId: string, note: string) =>
  api.post(`/v1/audit/incidents/${encodeURIComponent(incidentId)}/acknowledge`, { note }, z.object({ id: z.string(), resolvedAt: z.string().nullable() }));

/** Re-verifies the latest entries (the API's default range) — audited. */
export const verifyRecentAuditChain = () => api.post('/v1/audit/verify', {}, AuditVerificationSchema, { timeoutMs: 60_000 });
