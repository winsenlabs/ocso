import type { InteractionPart, MediaPart } from '@ocso/domain';
import type { ChannelCapabilities, MediaKind, RenderedOutbound } from '../contract/types.js';
import { customerSafeParts } from '../contract/render-policy.js';
import { invalidOutbound } from '../common/errors.js';
import { baseMimeType } from '../common/mime.js';
import { clip } from '../common/text.js';
import { outboundMimeAllowed, WHATSAPP_CAPTION_LIMIT } from './capabilities.js';
import { toWhatsAppText } from './format.js';
import type { WhatsAppMediaPayload, WhatsAppOutboundPayload } from './payload.js';
import { renderStructured, textPayloads } from './render-structured.js';

/**
 * Canonical parts -> WhatsApp payloads. Only `customerSafeParts` are ever
 * considered (TOOL_RESULT and unsupported types are dropped first). Each
 * payload records the source part index so delivery can be traced back.
 */

type RendererMap = {
  [K in InteractionPart['type']]: (
    part: Extract<InteractionPart, { type: K }>,
    capabilities: ChannelCapabilities,
  ) => WhatsAppOutboundPayload[];
};
type AnyRenderer = (part: InteractionPart, capabilities: ChannelCapabilities) => WhatsAppOutboundPayload[];

const MEDIA_TYPE: Readonly<Record<MediaKind, WhatsAppMediaPayload['mediaType']>> = {
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  DOCUMENT: 'document',
};

function renderMedia(part: MediaPart, capabilities: ChannelCapabilities): WhatsAppOutboundPayload[] {
  const { media } = part;
  if (media.status !== 'STORED' || !media.blobKey) {
    throw invalidOutbound('outbound_media_not_stored', 'outbound media must be stored in BlobStore before rendering');
  }
  if (!outboundMimeAllowed(part.type, media.mimeType, capabilities)) {
    throw invalidOutbound('outbound_media_type_not_allowed', `WhatsApp cannot send ${part.type} as ${baseMimeType(media.mimeType)}`);
  }
  if (media.sizeBytes !== undefined && media.sizeBytes > capabilities.maxMediaBytes[part.type]) {
    throw invalidOutbound('outbound_media_too_large', `${part.type} exceeds the WhatsApp size limit`);
  }
  const rawCaption = 'caption' in part && part.caption ? toWhatsAppText(part.caption) : '';
  const inlineCaption = rawCaption && rawCaption.length <= WHATSAPP_CAPTION_LIMIT ? rawCaption : undefined;
  const payload: WhatsAppOutboundPayload = {
    type: 'media',
    mediaType: MEDIA_TYPE[part.type],
    blobKey: media.blobKey,
    mimeType: media.mimeType,
    ...(media.filename && part.type === 'DOCUMENT' ? { filename: clip(media.filename, 240) } : {}),
    ...(inlineCaption ? { caption: inlineCaption } : {}),
  };
  // Captions over 1024 chars follow the media as ordinary text messages.
  return rawCaption && !inlineCaption ? [payload, ...textPayloads(rawCaption)] : [payload];
}

type LocationPart = Extract<InteractionPart, { type: 'LOCATION' }>;
type ContactPart = Extract<InteractionPart, { type: 'CONTACT' }>;

function renderLocation(part: LocationPart): WhatsAppOutboundPayload[] {
  return [
    {
      type: 'location',
      latitude: part.latitude,
      longitude: part.longitude,
      ...(part.name ? { name: clip(part.name, 1_000) } : {}),
      ...(part.address ? { address: clip(part.address, 1_000) } : {}),
    },
  ];
}

function renderContacts(part: ContactPart): WhatsAppOutboundPayload[] {
  const contacts = part.contacts.map((card) => ({
    name: { formatted_name: card.name, first_name: card.name },
    ...(card.phones.length ? { phones: card.phones.map((phone) => ({ phone })) } : {}),
    ...(card.emails.length ? { emails: card.emails.map((email) => ({ email })) } : {}),
    ...(card.organization ? { org: { company: card.organization } } : {}),
  }));
  return [{ type: 'contacts', contacts }];
}

const RENDERERS: RendererMap = {
  TEXT: (part) => textPayloads(part.text),
  IMAGE: renderMedia,
  AUDIO: renderMedia,
  VIDEO: renderMedia,
  DOCUMENT: renderMedia,
  LOCATION: renderLocation,
  CONTACT: renderContacts,
  STRUCTURED: renderStructured,
  // Defense in depth: customerSafeParts already removed these.
  TOOL_RESULT: () => [],
};

export function renderWhatsAppParts(parts: readonly InteractionPart[], capabilities: ChannelCapabilities): RenderedOutbound[] {
  const safe = new Set(customerSafeParts(parts, capabilities).parts);
  const out: RenderedOutbound[] = [];
  parts.forEach((part, index) => {
    if (!safe.has(part)) return;
    const render = RENDERERS[part.type] as AnyRenderer;
    for (const payload of render(part, capabilities)) {
      out.push({ kind: 'WHATSAPP', payload, partIndexes: [index] });
    }
  });
  return out;
}
