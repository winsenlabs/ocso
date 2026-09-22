import { z } from 'zod';
import type { InteractionPart, MediaRef } from '@ocso/domain';
import { normalizeSha256 } from '../../common/crypto.js';
import { clip, nonEmpty } from '../../common/text.js';
import type { WaMessage } from './schema.js';

/**
 * Media message normalizers: image, sticker, audio/voice, video, document.
 * Parts reference the media by WhatsApp media id (`status: 'PENDING'`); a
 * worker later calls `fetchMedia` and stores the bytes in BlobStore.
 */

const WaMedia = z.object({
  id: z.string().min(1),
  mime_type: z.string().min(1),
  sha256: z.string().optional(),
  caption: z.string().optional(),
  filename: z.string().optional(),
  voice: z.boolean().optional(),
});
type WaMedia = z.infer<typeof WaMedia>;

const CAPTION_MAX = 4_000;
const FILENAME_MAX = 255;

function mediaRef(media: WaMedia): MediaRef {
  const sha256 = normalizeSha256(media.sha256);
  const filename = nonEmpty(media.filename);
  return {
    status: 'PENDING',
    mimeType: media.mime_type,
    source: { channel: 'WHATSAPP', externalId: media.id },
    ...(sha256 ? { sha256 } : {}),
    ...(filename ? { filename: clip(filename.replace(/[/\\]/g, '_'), FILENAME_MAX) } : {}),
  };
}

function caption(media: WaMedia): { caption?: string } {
  const text = nonEmpty(media.caption);
  return text ? { caption: clip(text, CAPTION_MAX) } : {};
}

function mediaOf(message: WaMessage, key: string): WaMedia | null {
  const parsed = WaMedia.safeParse(message[key]);
  return parsed.success ? parsed.data : null;
}

export function normalizeImage(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'image');
  return media ? [{ type: 'IMAGE', media: mediaRef(media), ...caption(media) }] : null;
}

/** Stickers are images (WebP) for OCSO; the sticker-ness is not semantically relevant. */
export function normalizeSticker(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'sticker');
  return media ? [{ type: 'IMAGE', media: mediaRef(media) }] : null;
}

export function normalizeAudio(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'audio');
  return media ? [{ type: 'AUDIO', media: mediaRef(media), voiceNote: media.voice === true }] : null;
}

/** Older payloads carry recorded voice notes as `type: "voice"`. */
export function normalizeVoice(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'voice');
  return media ? [{ type: 'AUDIO', media: mediaRef(media), voiceNote: true }] : null;
}

export function normalizeVideo(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'video');
  return media ? [{ type: 'VIDEO', media: mediaRef(media), ...caption(media) }] : null;
}

export function normalizeDocument(message: WaMessage): InteractionPart[] | null {
  const media = mediaOf(message, 'document');
  return media ? [{ type: 'DOCUMENT', media: mediaRef(media), ...caption(media) }] : null;
}
