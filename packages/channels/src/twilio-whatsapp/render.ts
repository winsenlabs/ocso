import { choicesOf, type InteractionPart, type MediaPart } from '@ocso/domain';
import { renderChoicesAsText } from '../contract/choices.js';
import type { ChannelCapabilities, RenderedOutbound } from '../contract/types.js';
import { customerSafeParts } from '../contract/render-policy.js';
import { chunkText } from '../common/chunk.js';
import { invalidOutbound } from '../common/errors.js';
import { baseMimeType } from '../common/mime.js';
import { clip } from '../common/text.js';
import { toWhatsAppText } from '../whatsapp/format.js';
import { TWILIO_BODY_LIMIT, twilioOutboundMimeAllowed } from './capabilities.js';
import type { TwilioOutboundPayload } from './payload.js';

/**
 * Canonical parts -> Twilio WhatsApp payloads. Reuses the Meta adapter's
 * CommonMark -> WhatsApp formatter; text is chunked to Twilio's 1,600
 * character Body limit. Only `customerSafeParts` are rendered; each payload
 * records its source part index.
 */

type Renderer = (part: InteractionPart, capabilities: ChannelCapabilities) => TwilioOutboundPayload[];
type LocationPart = Extract<InteractionPart, { type: 'LOCATION' }>;
type ContactPart = Extract<InteractionPart, { type: 'CONTACT' }>;
type StructuredPart = Extract<InteractionPart, { type: 'STRUCTURED' }>;
type TextPart = Extract<InteractionPart, { type: 'TEXT' }>;

export function textPayloads(markdown: string): TwilioOutboundPayload[] {
  return chunkText(toWhatsAppText(markdown), TWILIO_BODY_LIMIT).map((body) => ({ type: 'text', body }));
}

function renderMedia(part: MediaPart, capabilities: ChannelCapabilities): TwilioOutboundPayload[] {
  const { media } = part;
  if (media.status !== 'STORED' || !media.blobKey) {
    throw invalidOutbound('outbound_media_not_stored', 'outbound media must be stored in BlobStore before rendering');
  }
  if (!twilioOutboundMimeAllowed(part.type, media.mimeType)) {
    throw invalidOutbound('outbound_media_type_not_allowed', `WhatsApp (Twilio) cannot send ${part.type} as ${baseMimeType(media.mimeType)}`);
  }
  if (media.sizeBytes !== undefined && media.sizeBytes > capabilities.maxMediaBytes[part.type]) {
    throw invalidOutbound('outbound_media_too_large', `${part.type} exceeds the WhatsApp (Twilio) size limit`);
  }
  const caption = 'caption' in part && part.caption ? toWhatsAppText(part.caption) : '';
  // WhatsApp delivers a Body only with images; everything else gets the caption as a follow-up text.
  const inline = part.type === 'IMAGE' && caption && caption.length <= TWILIO_BODY_LIMIT ? caption : undefined;
  const payload: TwilioOutboundPayload = {
    type: 'media',
    mediaKind: part.type,
    blobKey: media.blobKey,
    mimeType: media.mimeType,
    ...(inline ? { caption: inline } : {}),
  };
  return caption && !inline ? [payload, ...textPayloads(caption)] : [payload];
}

function renderLocation(part: LocationPart): TwilioOutboundPayload[] {
  const name = part.name ?? part.address ?? `${part.latitude}, ${part.longitude}`;
  const label = part.name && part.address ? clip(part.address, 1_000) : undefined;
  return [{ type: 'location', latitude: part.latitude, longitude: part.longitude, name: clip(name, 1_000), ...(label ? { label } : {}) }];
}

/** Contact cards as readable text (Twilio would need a hosted vCard file). */
function renderContacts(part: ContactPart): TwilioOutboundPayload[] {
  const cards = part.contacts.map((card) => [`**${card.name}**`, card.organization, ...card.phones, ...card.emails].filter(Boolean).join('\n'));
  return textPayloads(cards.join('\n\n'));
}

/** Interactive buttons need Content Templates on Twilio: CHOICES and buttons go out as numbered text. */
function renderStructured(part: StructuredPart): TwilioOutboundPayload[] {
  const choices = choicesOf(part);
  if (choices) return textPayloads(renderChoicesAsText(choices));
  if (part.fallbackText?.trim()) return textPayloads(part.fallbackText);
  const body = typeof part.data['body'] === 'string' ? part.data['body'] : '';
  const buttons = Array.isArray(part.data['buttons']) ? (part.data['buttons'] as unknown[]) : [];
  const titles = buttons.flatMap((b) => (b && typeof b === 'object' && typeof (b as { title?: unknown }).title === 'string' ? [(b as { title: string }).title] : []));
  if (!body.trim() || !titles.length) return [];
  return textPayloads([body, '', ...titles.map((title, i) => `${i + 1}. ${title}`)].join('\n'));
}

const RENDERERS: Readonly<Record<InteractionPart['type'], Renderer>> = {
  TEXT: (part) => textPayloads((part as TextPart).text),
  IMAGE: (part, caps) => renderMedia(part as MediaPart, caps),
  AUDIO: (part, caps) => renderMedia(part as MediaPart, caps),
  VIDEO: (part, caps) => renderMedia(part as MediaPart, caps),
  DOCUMENT: (part, caps) => renderMedia(part as MediaPart, caps),
  LOCATION: (part) => renderLocation(part as LocationPart),
  CONTACT: (part) => renderContacts(part as ContactPart),
  STRUCTURED: (part) => renderStructured(part as StructuredPart),
  // Defense in depth: customerSafeParts already removed these.
  TOOL_RESULT: () => [],
};

export function renderTwilioParts(parts: readonly InteractionPart[], capabilities: ChannelCapabilities): RenderedOutbound[] {
  const safe = new Set(customerSafeParts(parts, capabilities).parts);
  const out: RenderedOutbound[] = [];
  parts.forEach((part, index) => {
    if (!safe.has(part)) return;
    for (const payload of RENDERERS[part.type](part, capabilities)) out.push({ kind: 'TWILIO_WHATSAPP', payload, partIndexes: [index] });
  });
  return out;
}
