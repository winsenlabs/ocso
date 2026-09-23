import type { InteractionPart, MediaRef } from '@ocso/domain';
import { baseMimeType } from '../../common/mime.js';
import { clip, nonEmpty } from '../../common/text.js';
import { mediaKindOfMime } from '../capabilities.js';
import type { FormRecord } from '../form.js';

/**
 * Media, location and text from an inbound Twilio webhook (PM/research/06 §1).
 * Twilio has no message-type field: the shape is inferred from `NumMedia` /
 * `MediaUrl{N}` / `MediaContentType{N}`, `Latitude` / `Longitude` and `Body`.
 * Media parts are PENDING references to the Twilio media URL; the worker
 * fetches them through `fetchMedia` (credentials only to the API host).
 */

export const TWILIO_MEDIA_SOURCE = 'TWILIO_WHATSAPP';

const MAX_MEDIA = 10;
const CAPTION_MAX = 4_000;
const VCARD_TYPES: ReadonlySet<string> = new Set(['text/vcard', 'text/x-vcard']);

function mediaRef(url: string, mimeType: string): MediaRef {
  const vcard = VCARD_TYPES.has(baseMimeType(mimeType));
  return {
    status: 'PENDING',
    mimeType: clip(mimeType, 255),
    source: { channel: TWILIO_MEDIA_SOURCE, externalId: url },
    // Shared contact cards arrive as vCard media; give them a readable name.
    ...(vcard ? { filename: 'contact.vcf' } : {}),
  };
}

/**
 * One part per media item. WhatsApp puts a media caption in `Body`: it is
 * attached to the first image, video or document; `captionUsed` tells the
 * caller not to repeat it as text.
 */
export function mediaParts(form: FormRecord, body: string | undefined): { parts: InteractionPart[]; captionUsed: boolean } {
  const count = Math.min(Number.parseInt(form['NumMedia'] ?? '0', 10) || 0, MAX_MEDIA);
  const parts: InteractionPart[] = [];
  let captionUsed = false;
  for (let i = 0; i < count; i += 1) {
    const url = nonEmpty(form[`MediaUrl${i}`]);
    const mimeType = nonEmpty(form[`MediaContentType${i}`]);
    if (!url || !mimeType) continue;
    const media = mediaRef(url, mimeType);
    const kind = mediaKindOfMime(mimeType);
    if (kind === 'AUDIO') {
      parts.push({ type: 'AUDIO', media });
      continue;
    }
    if (body && !captionUsed) {
      parts.push({ type: kind, media, caption: clip(body, CAPTION_MAX) });
      captionUsed = true;
    } else {
      parts.push({ type: kind, media });
    }
  }
  return { parts, captionUsed };
}

function coordinate(value: string | undefined, limit: number): number | null {
  const n = value === undefined || value.trim() === '' ? Number.NaN : Number(value);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
}

/** `Latitude` / `Longitude` (+ `Label`, `Address`) — a shared location. */
export function locationPart(form: FormRecord): InteractionPart | null {
  const latitude = coordinate(form['Latitude'], 90);
  const longitude = coordinate(form['Longitude'], 180);
  if (latitude === null || longitude === null) return null;
  const name = nonEmpty(form['Label']);
  const address = nonEmpty(form['Address']);
  return {
    type: 'LOCATION',
    latitude,
    longitude,
    ...(name ? { name: clip(name, 500) } : {}),
    ...(address ? { address: clip(address, 1_000) } : {}),
  };
}

export function textPart(body: string | undefined): InteractionPart | null {
  return body ? { type: 'TEXT', text: clip(body, 32_000) } : null;
}
