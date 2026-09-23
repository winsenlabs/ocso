import type { ChannelCapabilities } from '../contract/types.js';

/**
 * First-party web chat. Streaming is native (AI SDK UI stream over SSE), so
 * there is no session window and no provider-side delivery receipts.
 * STRUCTURED is accepted inbound for widget button/form replies.
 */

const MB = 1024 * 1024;

export const WEBCHAT_TEXT_LIMIT = 8_000;

export const WEBCHAT_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  inboundParts: ['TEXT', 'IMAGE', 'DOCUMENT', 'STRUCTURED'],
  outboundParts: ['TEXT', 'IMAGE', 'DOCUMENT', 'STRUCTURED'],
  maxTextLength: WEBCHAT_TEXT_LIMIT,
  markdown: 'commonmark',
  streaming: true,
  deliveryReceipts: false,
  interactive: true,
  maxMediaBytes: { IMAGE: 10 * MB, AUDIO: 0, VIDEO: 0, DOCUMENT: 20 * MB },
  allowedMimeTypes: {
    IMAGE: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
    AUDIO: [],
    VIDEO: [],
    DOCUMENT: [
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  sessionWindowHours: null,
  // The widget shows CHOICES as buttons (it has no separate list form).
  choices: { buttons: 10, list: 0 },
});

/** Audio types accepted when a channel opts in (`settings.audioAttachments`); all are content-sniffable. */
export const WEBCHAT_AUDIO_TYPES: readonly string[] = ['audio/mpeg', 'audio/mp4', 'audio/ogg'];

export const WEBCHAT_AUDIO_CAPABILITIES: ChannelCapabilities = Object.freeze<ChannelCapabilities>({
  ...WEBCHAT_CAPABILITIES,
  inboundParts: [...WEBCHAT_CAPABILITIES.inboundParts, 'AUDIO'],
  maxMediaBytes: { ...WEBCHAT_CAPABILITIES.maxMediaBytes, AUDIO: 16 * MB },
  allowedMimeTypes: { ...WEBCHAT_CAPABILITIES.allowedMimeTypes, AUDIO: [...WEBCHAT_AUDIO_TYPES] },
});

/** Capabilities of one web chat channel: the defaults, plus inbound audio when the channel opts in. */
export function webChatCapabilities(settings: Readonly<Record<string, unknown>> | undefined): ChannelCapabilities {
  return settings?.['audioAttachments'] === true ? WEBCHAT_AUDIO_CAPABILITIES : WEBCHAT_CAPABILITIES;
}
