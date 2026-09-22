import type { MediaObjectSource } from './outbound-media.js';
import type { WhatsAppOutboundPayload } from './payload.js';

/**
 * Payload -> Cloud API `POST /{phone-number-id}/messages` JSON body. Media
 * payloads need their resolved `id`/`link` passed in. One builder per type.
 */

type Builders = {
  [K in WhatsAppOutboundPayload['type']]: (
    payload: Extract<WhatsAppOutboundPayload, { type: K }>,
    media: MediaObjectSource | null,
  ) => Record<string, unknown>;
};
type AnyBuilder = (payload: WhatsAppOutboundPayload, media: MediaObjectSource | null) => Record<string, unknown>;

const BUILDERS: Builders = {
  text: (p) => ({ type: 'text', text: { body: p.body, preview_url: p.previewUrl } }),
  media: (p, media) => ({
    type: p.mediaType,
    [p.mediaType]: {
      ...media,
      ...(p.caption && p.mediaType !== 'audio' ? { caption: p.caption } : {}),
      ...(p.filename && p.mediaType === 'document' ? { filename: p.filename } : {}),
    },
  }),
  location: (p) => ({
    type: 'location',
    location: {
      latitude: p.latitude,
      longitude: p.longitude,
      ...(p.name ? { name: p.name } : {}),
      ...(p.address ? { address: p.address } : {}),
    },
  }),
  contacts: (p) => ({ type: 'contacts', contacts: p.contacts }),
  interactive: (p) => ({ type: 'interactive', interactive: p.interactive }),
  template: (p) => ({
    type: 'template',
    template: {
      name: p.template.name,
      language: { code: p.template.language },
      ...(p.template.components?.length ? { components: p.template.components } : {}),
    },
  }),
};

export function buildMessageBody(
  payload: WhatsAppOutboundPayload,
  recipient: Record<string, string>,
  media: MediaObjectSource | null,
): Record<string, unknown> {
  const build = BUILDERS[payload.type] as AnyBuilder;
  return { messaging_product: 'whatsapp', recipient_type: 'individual', ...recipient, ...build(payload, media) };
}
