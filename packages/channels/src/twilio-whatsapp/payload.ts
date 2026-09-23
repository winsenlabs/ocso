import { z } from 'zod';
import { TWILIO_BODY_LIMIT } from './capabilities.js';

/**
 * The adapter-private `RenderedOutbound.payload` shape. `render()` produces
 * it; `send()` re-validates it (payloads may round-trip through an outbox)
 * and turns it into a form-encoded `POST …/Messages.json`. Media stays a
 * BlobStore reference until send time, when it becomes a short-lived signed
 * URL Twilio downloads (one media item per WhatsApp message).
 */

export const CONTENT_SID = /^HX[0-9a-fA-F]{32}$/;

export const TwilioContentTemplate = z.object({
  /** Approved WhatsApp template in Twilio's Content Template Builder (HX…). */
  contentSid: z.string().regex(CONTENT_SID, 'must be a Twilio Content SID (HX followed by 32 hex characters)'),
  /** Placeholder values keyed by placeholder name/number, e.g. `{ "1": "Priya" }`; sent as ContentVariables JSON. */
  variables: z.record(z.string().regex(/^[A-Za-z0-9_]{1,64}$/, 'invalid placeholder key'), z.string().max(1_024)).optional(),
});
export type TwilioContentTemplate = z.infer<typeof TwilioContentTemplate>;

export const TwilioOutboundPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), body: z.string().min(1).max(TWILIO_BODY_LIMIT) }),
  z.object({
    type: z.literal('media'),
    mediaKind: z.enum(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT']),
    blobKey: z.string().min(1),
    mimeType: z.string().min(1),
    /** Delivered by WhatsApp with images only; other kinds send their caption as a following text. */
    caption: z.string().min(1).max(TWILIO_BODY_LIMIT).optional(),
  }),
  z.object({
    type: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    /** Sent as Body (required by Twilio for location messages). */
    name: z.string().min(1).max(1_000),
    label: z.string().max(1_000).optional(),
  }),
  z.object({ type: z.literal('template'), template: TwilioContentTemplate }),
]);
export type TwilioOutboundPayload = z.infer<typeof TwilioOutboundPayload>;
export type TwilioMediaPayload = Extract<TwilioOutboundPayload, { type: 'media' }>;
