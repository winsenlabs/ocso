import { z } from 'zod';

/**
 * Lenient zod schemas for Meta's webhook envelope (field `messages` and
 * `user_id_update`). Unknown keys are tolerated so API drift does not break
 * ingestion; each message/status is parsed on its own so one malformed item
 * never drops the rest of a batch.
 */

export const WebhookEnvelope = z.object({
  object: z.string(),
  entry: z.array(
    z.object({
      /** WhatsApp Business Account id. */
      id: z.string().optional(),
      changes: z.array(z.object({ field: z.string(), value: z.unknown() })).default([]),
    }),
  ),
});

export const WaMetadata = z.object({
  phone_number_id: z.string().min(1),
  display_phone_number: z.string().optional(),
});

export const WaContact = z.object({
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  parent_user_id: z.string().optional(),
  profile: z.object({ name: z.string().optional(), username: z.string().optional() }).optional(),
});
export type WaContact = z.infer<typeof WaContact>;

export const MessagesValue = z.object({
  metadata: WaMetadata,
  contacts: z.array(WaContact).default([]),
  messages: z.array(z.unknown()).default([]),
  statuses: z.array(z.unknown()).default([]),
  errors: z.array(z.unknown()).default([]),
});

export const WaReferral = z.object({
  source_url: z.string().optional(),
  source_type: z.string().optional(),
  source_id: z.string().optional(),
  headline: z.string().optional(),
  body: z.string().optional(),
  ctwa_clid: z.string().optional(),
});

/** Fields common to every inbound message; the type-specific object stays on the loose record. */
export const WaMessageBase = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  timestamp: z.string().optional(),
  from: z.string().optional(),
  from_user_id: z.string().optional(),
  from_parent_user_id: z.string().optional(),
  context: z.object({ id: z.string().optional(), from: z.string().optional() }).optional(),
  referral: WaReferral.optional(),
});
export type WaMessage = z.infer<typeof WaMessageBase>;

export const WaStatus = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().optional(),
  recipient_id: z.string().optional(),
  recipient_user_id: z.string().optional(),
  errors: z
    .array(
      z.object({
        code: z.union([z.number(), z.string()]).optional(),
        title: z.string().optional(),
        message: z.string().optional(),
      }),
    )
    .default([]),
});

const PreviousCurrent = z.object({ previous: z.string().optional(), current: z.string().optional() });

export const UserIdUpdateValue = z.object({
  metadata: WaMetadata.optional(),
  user_id_update: z
    .array(
      z.object({
        wa_id: z.string().optional(),
        timestamp: z.string().optional(),
        user_id: PreviousCurrent.optional(),
        parent_user_id: PreviousCurrent.optional(),
      }),
    )
    .default([]),
});

export const WaSystem = z.object({
  type: z.string(),
  wa_id: z.string().optional(),
  user_id: z.string().optional(),
  body: z.string().optional(),
});

/** Unix seconds (string) -> Date; falls back when absent or malformed. */
export function unixSecondsToDate(value: string | undefined, fallback: () => Date): Date {
  return value && /^\d{1,12}$/.test(value) ? new Date(Number(value) * 1000) : fallback();
}
