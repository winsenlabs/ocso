import type { ChannelCapabilities, MediaKind } from '../contract/types.js';
import { baseMimeType, isMimeAllowed } from '../common/mime.js';

/**
 * WhatsApp Cloud API capabilities (PM/research/02 §5, Meta "supported media
 * types"). Image `image/webp` is accepted inbound only (stickers normalize to
 * IMAGE); outbound images must be JPEG/PNG — see OUTBOUND_IMAGE_MIME_TYPES.
 */

const MB = 1024 * 1024;

export const WHATSAPP_TEXT_LIMIT = 4096;
export const WHATSAPP_CAPTION_LIMIT = 1024;
export const WHATSAPP_INTERACTIVE_BODY_LIMIT = 1024;
export const WHATSAPP_INTERACTIVE_HEADER_LIMIT = 60;
export const WHATSAPP_INTERACTIVE_FOOTER_LIMIT = 60;
export const WHATSAPP_MAX_REPLY_BUTTONS = 3;
export const WHATSAPP_BUTTON_TITLE_LIMIT = 20;
export const WHATSAPP_BUTTON_ID_LIMIT = 256;
export const WHATSAPP_SESSION_WINDOW_HOURS = 24;

export const OUTBOUND_IMAGE_MIME_TYPES: readonly string[] = ['image/jpeg', 'image/png'];

export const WHATSAPP_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'STRUCTURED'],
  outboundParts: ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'STRUCTURED'],
  maxTextLength: WHATSAPP_TEXT_LIMIT,
  markdown: 'whatsapp',
  streaming: false,
  deliveryReceipts: true,
  interactive: true,
  maxMediaBytes: { IMAGE: 5 * MB, AUDIO: 16 * MB, VIDEO: 16 * MB, DOCUMENT: 100 * MB },
  allowedMimeTypes: {
    IMAGE: ['image/jpeg', 'image/png', 'image/webp'],
    AUDIO: ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'],
    VIDEO: ['video/mp4', 'video/3gpp'],
    DOCUMENT: [
      'text/plain',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  sessionWindowHours: WHATSAPP_SESSION_WINDOW_HOURS,
  identityKinds: ['whatsapp_bsuid', 'whatsapp_phone', 'whatsapp_parent_bsuid'],
});

/** Whether WhatsApp accepts this MIME type for an outbound message of `kind`. */
export function outboundMimeAllowed(kind: MediaKind, mimeType: string, capabilities: ChannelCapabilities): boolean {
  if (kind === 'IMAGE') return OUTBOUND_IMAGE_MIME_TYPES.includes(baseMimeType(mimeType));
  return isMimeAllowed(capabilities, kind, mimeType);
}
