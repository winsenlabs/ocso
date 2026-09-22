import { z } from 'zod';

/**
 * Configurable retention (docs/15 §8). Days per data class; audit retention is
 * independent of conversation retention and has a floor. Logs and traces live
 * in the log/trace backends (CloudWatch log-group retention, OTel backend) and
 * are configured there, not here.
 */
export const RETENTION_CLASSES = {
  /** Message text, notes, summaries, drafts and tool payloads of RESOLVED conversations. */
  conversationContent: { defaultDays: 365, minDays: 7, label: 'Conversation content', description: 'Message text, notes, summaries and drafts of resolved conversations (structure and analytics are kept).' },
  /** Stored media bytes (images, documents, audio, video), by upload age. */
  media: { defaultDays: 180, minDays: 1, label: 'Media', description: 'Stored images, documents, audio and video, by upload age.' },
  /** Sanitized tool arguments and result summaries, by call age. */
  toolPayloads: { defaultDays: 90, minDays: 1, label: 'Tool payloads', description: 'Sanitized tool arguments and result summaries.' },
  /** Internal OCSO agent threads and messages. */
  internalAgent: { defaultDays: 90, minDays: 1, label: 'Ask OCSO history', description: 'Internal OCSO agent threads and messages.' },
  /** Model usage events (cost and token analytics). */
  usage: { defaultDays: 400, minDays: 30, label: 'Model usage', description: 'Token and cost records behind usage analytics.' },
  /** Operational records: published outbox events, health samples, delivery logs, login attempts. */
  operational: { defaultDays: 14, minDays: 1, label: 'Operational records', description: 'Published events, health samples, delivery logs and login attempts.' },
  /** Audit trail. */
  auditEvents: { defaultDays: 2555, minDays: 365, label: 'Audit trail', description: 'Audit events; the database refuses to delete anything younger than 365 days.' },
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

/** Retention classes with their effective values, for the settings screen. */
export function describeRetention(stored: Readonly<Record<string, number>>) {
  const effective = effectiveRetention(stored);
  return RETENTION_CLASS_KEYS.map((key) => ({ key, ...RETENTION_CLASSES[key], days: effective[key], overridden: stored[key] !== undefined && stored[key] === effective[key] }));
}
