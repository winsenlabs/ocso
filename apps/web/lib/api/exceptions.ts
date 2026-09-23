import 'server-only';
import { z } from 'zod';
import { api } from './client';

/**
 * The exception report (PM/research/11 §7): GET /v1/exceptions/live,
 * /v1/exceptions/reports(/:id) (exceptions.read, scoped), POST …/sign,
 * …/regenerate and POST /v1/exceptions/reports (exceptions.sign). The export zip is streamed by
 * the route handler under /exceptions/reports/[id]/export.
 */

const Severity = z.enum(['critical', 'high', 'medium', 'low']);

export const ExceptionItemSchema = z.object({
  objectKind: z.string(),
  objectId: z.string().nullable(),
  title: z.string(),
  detail: z.string(),
  occurredAt: z.string(),
  href: z.string().nullable(),
  teamIds: z.array(z.string()),
  readableWith: z.string().nullable().optional(),
  actorIds: z.array(z.string()).optional(),
  subjectIds: z.array(z.string()).optional(),
  count: z.number(),
});
export type ExceptionItem = z.infer<typeof ExceptionItemSchema>;

export const ExceptionSectionSchema = z.object({
  id: z.string(),
  label: z.string(),
  severity: Severity,
  description: z.string(),
  items: z.array(ExceptionItemSchema),
  total: z.number(),
  truncated: z.boolean(),
  coverage: z.object({ dataFrom: z.string(), complete: z.boolean() }).nullable().optional(),
  error: z.string().nullable(),
});
export type ExceptionSection = z.infer<typeof ExceptionSectionSchema>;

const Totals = z.object({
  items: z.number(),
  bySeverity: z.record(Severity, z.number()),
  failedChecks: z.number(),
  truncatedChecks: z.number().optional(),
  incompleteChecks: z.number().optional(),
});

export const ExceptionContentSchema = z.object({
  format: z.string(),
  period: z.object({ start: z.string(), end: z.string(), timezone: z.string() }),
  generatedAt: z.string(),
  sections: z.array(ExceptionSectionSchema),
  totals: Totals,
});
export type ExceptionContent = z.infer<typeof ExceptionContentSchema>;

const Person = z.object({ id: z.string(), name: z.string() }).nullable();

export const ExceptionReportSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(['WEEKLY', 'ADHOC']),
  periodStart: z.string(),
  periodEnd: z.string(),
  timezone: z.string(),
  status: z.enum(['DRAFT', 'SIGNED', 'SUPERSEDED']),
  generatedAt: z.string(),
  generatedBy: Person,
  signedAt: z.string().nullable(),
  signedBy: Person,
  contentHash: z.string(),
  totals: Totals,
  attestation: z.array(z.string()),
  supersededBy: z.string().nullable(),
  scoped: z.boolean(),
});
export type ExceptionReportSummary = z.infer<typeof ExceptionReportSummarySchema>;

export const ExceptionReportDetailSchema = ExceptionReportSummarySchema.extend({
  signNote: z.string().nullable(),
  keyId: z.string().nullable(),
  signature: z.string().nullable(),
  verification: z.enum(['VALID', 'INVALID', 'UNKNOWN_KEY', 'CONTENT_CHANGED']).nullable(),
  keyTrust: z.enum(['CURRENT', 'RETIRED', 'UNKNOWN']).nullable(),
  content: ExceptionContentSchema,
  canSign: z.boolean(),
  signBlocked: z.enum(['signing_key_unavailable', 'superseded', 'signed']).nullable(),
  attestationRequired: z.array(z.string()),
  canRegenerate: z.boolean(),
  canExport: z.boolean(),
});
export type ExceptionReportDetail = z.infer<typeof ExceptionReportDetailSchema>;

const LiveSchema = z.object({ content: ExceptionContentSchema, scoped: z.boolean() });
const PageSchema = z.object({ rows: z.array(ExceptionReportSummarySchema), next: z.object({ before: z.string(), beforeId: z.string() }).nullable() });

/** The live view is computed on read (every check, every time): allow it more than the default timeout. */
export const loadLiveExceptions = () => api.get('/v1/exceptions/live', LiveSchema, { timeoutMs: 30_000 });

export function listExceptionReports(q: { before?: string | undefined; beforeId?: string | undefined; limit?: number } = {}) {
  const params = new URLSearchParams({ limit: String(q.limit ?? 25) });
  if (q.before && q.beforeId) {
    params.set('before', q.before);
    params.set('beforeId', q.beforeId);
  }
  return api.get(`/v1/exceptions/reports?${params}`, PageSchema);
}

export const loadExceptionReport = (id: string) => api.get(`/v1/exceptions/reports/${encodeURIComponent(id)}`, ExceptionReportDetailSchema);

export const signExceptionReport = (id: string, body: { contentHash: string; note?: string | undefined; acknowledge: string[] }) =>
  api.post(`/v1/exceptions/reports/${encodeURIComponent(id)}/sign`, body, ExceptionReportDetailSchema);

export const regenerateExceptionReport = (id: string, body: { reason: string }) =>
  api.post(`/v1/exceptions/reports/${encodeURIComponent(id)}/regenerate`, body, ExceptionReportDetailSchema, { timeoutMs: 30_000 });

export const createAdhocExceptionReport = (body: { periodStart: string; periodEnd: string }) =>
  api.post('/v1/exceptions/reports', body, ExceptionReportDetailSchema, { timeoutMs: 30_000 });
