import { z } from 'zod';
import { ATTESTATION_FLAGS } from './attestation.js';
import { ADHOC_MAX_DAYS } from './periods.js';

/** GET /v1/exceptions/reports: keyset by (period_start, id) descending. */
export const ExceptionReportQuery = z.object({
  kind: z.enum(['WEEKLY', 'ADHOC']).optional(),
  status: z.enum(['DRAFT', 'SIGNED', 'SUPERSEDED']).optional(),
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type ExceptionReportQuery = z.infer<typeof ExceptionReportQuery>;

/** POST /v1/exceptions/reports/:id/sign — the note is optional; the signature says who and when. */
export const ExceptionSignInput = z.object({
  note: z.string().trim().max(2000).optional(),
  /** The content hash the signer was shown; a mismatch refuses the signature (409 report_changed). */
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  /** Attestation flags the signer acknowledges (409 attestation_required names any missing). */
  acknowledge: z.array(z.enum(ATTESTATION_FLAGS)).max(ATTESTATION_FLAGS.length).optional(),
});
export type ExceptionSignInput = z.infer<typeof ExceptionSignInput>;

/** POST /v1/exceptions/reports — an ad-hoc report over a past period (at most ADHOC_MAX_DAYS). */
export const ExceptionAdhocInput = z
  .object({ periodStart: z.iso.datetime({ offset: true }), periodEnd: z.iso.datetime({ offset: true }) })
  .refine((v) => new Date(v.periodEnd) > new Date(v.periodStart), { message: 'periodEnd must be after periodStart', path: ['periodEnd'] })
  .refine((v) => new Date(v.periodEnd).getTime() - new Date(v.periodStart).getTime() <= ADHOC_MAX_DAYS * 86_400_000, {
    message: `a report covers at most ${ADHOC_MAX_DAYS} days`,
    path: ['periodEnd'],
  });
export type ExceptionAdhocInput = z.infer<typeof ExceptionAdhocInput>;

/** POST /v1/exceptions/reports/:id/regenerate — why the draft is replaced (audited). */
export const ExceptionRegenerateInput = z.object({ reason: z.string().trim().min(3).max(500) });
export type ExceptionRegenerateInput = z.infer<typeof ExceptionRegenerateInput>;
