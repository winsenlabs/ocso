import type { ChannelCapabilities, MediaKind } from '../contract/types.js';
import { baseMimeType, isMimeAllowed } from '../common/mime.js';
import { WHATSAPP_IDENTITY } from '../whatsapp/identity.js';

/**
 * WhatsApp through Twilio Programmable Messaging (PM/research/06 §5, §7):
 * - `Body` is capped at 1,600 characters by Twilio (error 21617), not 4,096;
 * - one media item per WhatsApp message (extra MediaUrl values are ignored);
 * - a Body is delivered with images only — video, audio, documents and
 *   locations drop it, so their captions follow as separate text messages;
 * - images ≤ 5 MB (JPEG/PNG out, WebP stickers in), whole message ≤ 20 MB;
 * - shared contacts arrive as `text/vcard` media (a DOCUMENT here);
 * - interactive buttons need Content Templates, so buttons render as text.
 */

const MB = 1024 * 1024;

export const TWILIO_BODY_LIMIT = 1600;
export const TWILIO_SESSION_WINDOW_HOURS = 24;
export const TWILIO_OUTBOUND_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

export const TWILIO_WHATSAPP_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'STRUCTURED'],
  outboundParts: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'STRUCTURED'],
  maxTextLength: TWILIO_BODY_LIMIT,
  markdown: 'basic',
  streaming: false,
  deliveryReceipts: true,
  interactive: false,
  maxMediaBytes: { IMAGE: 5 * MB, AUDIO: 16 * MB, VIDEO: 16 * MB, DOCUMENT: 20 * MB },
  allowedMimeTypes: {
    IMAGE: ['image/jpeg', 'image/png', 'image/webp'],
    AUDIO: ['audio/ogg', 'audio/amr', 'audio/3gpp', 'audio/aac', 'audio/mpeg', 'audio/mp4'],
    VIDEO: ['video/mp4', 'video/3gpp'],
    DOCUMENT: [
      'text/plain',
      'text/vcard',
      'text/x-vcard',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  sessionWindowHours: TWILIO_SESSION_WINDOW_HOURS,
  // Twilio addresses users by phone; a BSUID (ExternalUserId) only when no phone is known.
  identityKinds: [WHATSAPP_IDENTITY.PHONE, WHATSAPP_IDENTITY.BSUID],
});

/** Whether Twilio's WhatsApp accepts this MIME type for an outbound message of `kind`. */
export function twilioOutboundMimeAllowed(kind: MediaKind, mimeType: string): boolean {
  if (kind === 'IMAGE') return TWILIO_OUTBOUND_IMAGE_MIME_TYPES.includes(baseMimeType(mimeType));
  return isMimeAllowed(TWILIO_WHATSAPP_CAPABILITIES, kind, mimeType);
}

/** Media kind for an inbound MIME type by family; the allowlist is enforced when the media is fetched. */
export function mediaKindOfMime(mimeType: string): MediaKind {
  const base = baseMimeType(mimeType);
  if (base.startsWith('image/')) return 'IMAGE';
  if (base.startsWith('audio/')) return 'AUDIO';
  if (base.startsWith('video/')) return 'VIDEO';
  return 'DOCUMENT';
}
