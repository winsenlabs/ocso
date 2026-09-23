import type { TemplateStatus } from '@ocso/domain';
import { z } from 'zod';
import type { TemplateStatusUpdate } from '../../contract/types.js';
import { shortText } from '../../common/templates.js';

/**
 * `message_template_status_update` webhooks (PM/research/10 §8): the review
 * result of a template, pushed by Meta. `message_template_id` is an integer
 * here (a string in REST) and the language may be hyphenated (`en-US`).
 * Events that are not a status (FLAGGED, LOCKED, REINSTATED, UNARCHIVED)
 * are ignored — the next status check picks up the restored state.
 */

const Value = z.looseObject({
  event: z.string(),
  message_template_id: z.union([z.number(), z.string()]).transform(String),
  message_template_name: z.string().default(''),
  message_template_language: z.string().default(''),
  reason: z.string().nullish(),
  rejection_info: z.looseObject({ reason: z.string().nullish() }).nullish(),
  other_info: z.looseObject({ description: z.string().nullish() }).nullish(),
});

const EVENTS: Readonly<Record<string, TemplateStatus>> = {
  APPROVED: 'APPROVED',
  PENDING: 'PENDING',
  IN_APPEAL: 'PENDING',
  REJECTED: 'REJECTED',
  LIMIT_EXCEEDED: 'REJECTED',
  PAUSED: 'PAUSED',
  DISABLED: 'DISABLED',
  ARCHIVED: 'DISABLED',
  DELETED: 'DISABLED',
  PENDING_DELETION: 'DISABLED',
};

export function templateUpdateFromChange(value: unknown, now: () => Date): TemplateStatusUpdate | null {
  const parsed = Value.safeParse(value);
  if (!parsed.success) return null;
  const v = parsed.data;
  const status = EVENTS[v.event.trim().toUpperCase()];
  if (!status) return null;
  const code = v.reason && v.reason.toUpperCase() !== 'NONE' ? v.reason : null;
  const deleted = v.event.toUpperCase() === 'DELETED' || v.event.toUpperCase() === 'PENDING_DELETION' ? 'Deleted at Meta' : null;
  const reason = shortText([code, v.rejection_info?.reason ?? v.other_info?.description ?? deleted].filter(Boolean).join(': '), 600);
  return {
    templateId: v.message_template_id,
    name: v.message_template_name,
    language: v.message_template_language.replace('-', '_'),
    status,
    reason,
    occurredAt: now(),
  };
}
