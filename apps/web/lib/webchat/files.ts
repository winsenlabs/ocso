import { mimeTypeOf } from './api';
import { MEDIA_KINDS, type MediaKind, type WebChatConfig } from './types';

/**
 * Client-side attachment checks against the channel's limits (from
 * `GET /config`). The API re-validates every upload (content sniffing, sizes),
 * so these exist to fail fast with a clear message, not as enforcement.
 */

export type FileCheck =
  | { ok: true; kind: MediaKind; mimeType: string }
  | { ok: false; reason: 'type' | 'size'; limitBytes?: number };

export function mediaKinds(config: WebChatConfig): MediaKind[] {
  return MEDIA_KINDS.filter((kind) => config.inboundParts.includes(kind) && config.maxMediaBytes[kind] > 0 && config.allowedMimeTypes[kind].length > 0);
}

export function attachmentsEnabled(config: WebChatConfig): boolean {
  return config.maxAttachmentsPerMessage > 0 && mediaKinds(config).length > 0;
}

/** Value for <input type=file accept>. */
export function acceptAttribute(config: WebChatConfig): string {
  return mediaKinds(config)
    .flatMap((kind) => config.allowedMimeTypes[kind])
    .join(',');
}

export function largestLimit(config: WebChatConfig): number {
  return Math.max(0, ...mediaKinds(config).map((kind) => config.maxMediaBytes[kind]));
}

export function checkFile(file: { name: string; type: string; size: number }, config: WebChatConfig): FileCheck {
  const mimeType = mimeTypeOf(file);
  const kind = mediaKinds(config).find((k) => config.allowedMimeTypes[k].includes(mimeType));
  if (!kind) return { ok: false, reason: 'type' };
  const limitBytes = config.maxMediaBytes[kind];
  if (file.size === 0 || file.size > limitBytes) return { ok: false, reason: 'size', limitBytes };
  return { ok: true, kind, mimeType };
}

export function kindOfMime(mimeType: string): 'image' | 'audio' | 'video' | 'pdf' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType === 'application/pdf') return 'pdf';
  return 'file';
}
