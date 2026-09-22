import { z } from 'zod';

/**
 * Configurable retention (docs/15 §8). Days per data class; audit retention is
 * independent of conversation retention and has a floor. Logs and traces live
 * in the log/trace backends (CloudWatch log-group retention, OTel backend) and
 * are configured there, not here.
 */
export const RETENTION_CLASSES = {
  /** Message text, notes, summaries, drafts and tool payloads of RESOLVED conversations. */
  conversationContent: { defaultDays: 365, minDays: 7 },
  /** Stored media bytes (images, documents, audio, video), by upload age. */
  media: { defaultDays: 180, minDays: 1 },
  /** Sanitized tool arguments and result summaries, by call age. */
  toolPayloads: { defaultDays: 90, minDays: 1 },
  /** Internal OCSO agent threads and messages. */
  internalAgent: { defaultDays: 90, minDays: 1 },
  /** Model usage events (cost and token analytics). */
  usage: { defaultDays: 400, minDays: 30 },
  /** Operational records: published outbox events, health samples, delivery logs, login attempts. */
  operational: { defaultDays: 14, minDays: 1 },
  /** Audit trail. */
  auditEvents: { defaultDays: 2555, minDays: 365 },
} as const;

export type RetentionClass = keyof typeof RETENTION_CLASSES;
export const RETENTION_CLASS_KEYS = Object.keys(RETENTION_CLASSES) as RetentionClass[];
export const MAX_RETENTION_DAYS = 3650;

export const RetentionInput = z
  .partialRecord(z.enum(RETENTION_CLASS_KEYS as [RetentionClass, ...RetentionClass[]]), z.number().int().max(MAX_RETENTION_DAYS))
  .superRefine((value, ctx) => {
    for (const [key, days] of Object.entries(value) as Array<[RetentionClass, number]>) {
      const min = RETENTION_CLASSES[key].minDays;
      if (days < min) ctx.addIssue({ code: 'custom', path: [key], message: `must be at least ${min} days` });
    }
  });
export type RetentionInput = z.infer<typeof RetentionInput>;

/** Stored overrides merged over defaults; unknown or out-of-range stored values fall back to defaults. */
export function effectiveRetention(stored: Readonly<Record<string, number>>): Record<RetentionClass, number> {
  const out = {} as Record<RetentionClass, number>;
  for (const key of RETENTION_CLASS_KEYS) {
    const value = stored[key];
    const { defaultDays, minDays } = RETENTION_CLASSES[key];
    out[key] = typeof value === 'number' && Number.isInteger(value) && value >= minDays && value <= MAX_RETENTION_DAYS ? value : defaultDays;
  }
  return out;
}
