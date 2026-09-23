import { z } from 'zod';
import {
  WHATSAPP_BUTTON_ID_LIMIT,
  WHATSAPP_BUTTON_TITLE_LIMIT,
  WHATSAPP_CAPTION_LIMIT,
  WHATSAPP_INTERACTIVE_BODY_LIMIT,
  WHATSAPP_INTERACTIVE_FOOTER_LIMIT,
  WHATSAPP_INTERACTIVE_HEADER_LIMIT,
  WHATSAPP_MAX_REPLY_BUTTONS,
  WHATSAPP_TEXT_LIMIT,
} from './capabilities.js';

/**
 * The adapter-private `RenderedOutbound.payload` shape. `render()` produces
 * it; `send()` re-validates it (payloads may round-trip through an outbox
 * table) and turns it into a Cloud API request. Media stays a BlobStore
 * reference until send time, when it becomes a signed link or an upload id.
 */

export const TemplateComponent = z.looseObject({
  type: z.string().min(1).max(32),
  sub_type: z.string().max(32).optional(),
  index: z.union([z.string().max(4), z.number().int().min(0).max(99)]).optional(),
  parameters: z.array(z.record(z.string(), z.unknown())).max(100).optional(),
});

export const WhatsAppTemplate = z.object({
  /** Approved template name (lower-case, digits, underscores). */
  name: z.string().regex(/^[a-z0-9_]{1,512}$/, 'invalid template name'),
  /** Template language/locale code, e.g. `en`, `en_US`, `pt_BR`. */
  language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/, 'invalid template language code'),
  components: z.array(TemplateComponent).max(20).optional(),
});
export type WhatsAppTemplate = z.infer<typeof WhatsAppTemplate>;

const MetaContact = z.object({
  name: z.object({ formatted_name: z.string().min(1), first_name: z.string().optional() }),
  phones: z.array(z.object({ phone: z.string().min(1) })).optional(),
  emails: z.array(z.object({ email: z.string().min(1) })).optional(),
  org: z.object({ company: z.string() }).optional(),
});

const ReplyButtons = z.object({
  type: z.literal('button'),
  header: z.object({ type: z.literal('text'), text: z.string().min(1).max(WHATSAPP_INTERACTIVE_HEADER_LIMIT) }).optional(),
  body: z.object({ text: z.string().min(1).max(WHATSAPP_INTERACTIVE_BODY_LIMIT) }),
  footer: z.object({ text: z.string().min(1).max(WHATSAPP_INTERACTIVE_FOOTER_LIMIT) }).optional(),
  action: z.object({
    buttons: z
      .array(
        z.object({
          type: z.literal('reply'),
          reply: z.object({
            id: z.string().min(1).max(WHATSAPP_BUTTON_ID_LIMIT),
            title: z.string().min(1).max(WHATSAPP_BUTTON_TITLE_LIMIT),
          }),
        }),
      )
      .min(1)
      .max(WHATSAPP_MAX_REPLY_BUTTONS),
  }),
});

export const WhatsAppOutboundPayload = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), body: z.string().min(1).max(WHATSAPP_TEXT_LIMIT), previewUrl: z.boolean() }),
  z.object({
    type: z.literal('media'),
    mediaType: z.enum(['image', 'audio', 'video', 'document']),
    blobKey: z.string().min(1),
    mimeType: z.string().min(1),
    filename: z.string().max(240).optional(),
    caption: z.string().max(WHATSAPP_CAPTION_LIMIT).optional(),
  }),
  z.object({
    type: z.literal('location'),
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    name: z.string().max(1_000).optional(),
    address: z.string().max(1_000).optional(),
  }),
  z.object({ type: z.literal('contacts'), contacts: z.array(MetaContact).min(1).max(20) }),
  z.object({ type: z.literal('interactive'), interactive: ReplyButtons }),
  z.object({ type: z.literal('template'), template: WhatsAppTemplate }),
]);
export type WhatsAppOutboundPayload = z.infer<typeof WhatsAppOutboundPayload>;
export type WhatsAppMediaPayload = Extract<WhatsAppOutboundPayload, { type: 'media' }>;
