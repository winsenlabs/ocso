import { isNativeFile, mimeTypeOf } from './api.js';
import type { AttachmentInput, MediaKind, WebChatConfig } from './types.js';
import { MEDIA_KINDS } from './wire.js';

/**
 * Client-side attachment checks against the channel's limits (from
 * `GET /config`). The API re-validates every upload (content sniffing, sizes);
 * these exist to fail fast with a clear message, not as enforcement.
 */

export type AttachmentCheck = { ok: true; kind: MediaKind; mimeType: string } | { ok: false; reason: 'type' | 'size' | 'disabled'; limitBytes?: number };

function mediaKinds(config: WebChatConfig): MediaKind[] {
  return MEDIA_KINDS.filter((kind) => config.inboundParts.includes(kind) && config.maxMediaBytes[kind] > 0 && config.allowedMimeTypes[kind].length > 0);
}

export function attachmentsEnabled(config: WebChatConfig): boolean {
  return config.maxAttachmentsPerMessage > 0 && mediaKinds(config).length > 0;
}

/** Every allowed MIME type (e.g. for `<input type=file accept>`). */
export function acceptedMimeTypes(config: WebChatConfig): string[] {
  return mediaKinds(config).reduce<string[]>((acc, kind) => acc.concat(config.allowedMimeTypes[kind]), []);
}

export function checkAttachment(file: AttachmentInput, config: WebChatConfig): AttachmentCheck {
  if (!attachmentsEnabled(config)) return { ok: false, reason: 'disabled' };
  const mimeType = mimeTypeOf({ name: file.name, type: file.type });
  const kind = mediaKinds(config).find((k) => config.allowedMimeTypes[k].includes(mimeType));
  if (!kind) return { ok: false, reason: 'type' };
  const limitBytes = config.maxMediaBytes[kind];
  const size = isNativeFile(file) ? null : file.size;
  if (size !== null && (size === 0 || size > limitBytes)) return { ok: false, reason: 'size', limitBytes };
  return { ok: true, kind, mimeType };
}
