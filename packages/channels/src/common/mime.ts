import type { ChannelCapabilities, MediaKind } from '../contract/types.js';

export const MEDIA_KINDS = ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] as const satisfies readonly MediaKind[];

/** `audio/ogg; codecs=opus` -> `audio/ogg`. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase();
}

/** The media kind whose allowlist contains this MIME type, or null when none does. */
export function mediaKindForMime(capabilities: ChannelCapabilities, mimeType: string): MediaKind | null {
  const base = baseMimeType(mimeType);
  return MEDIA_KINDS.find((kind) => capabilities.allowedMimeTypes[kind].includes(base)) ?? null;
}

export function isMimeAllowed(capabilities: ChannelCapabilities, kind: MediaKind, mimeType: string): boolean {
  return capabilities.allowedMimeTypes[kind].includes(baseMimeType(mimeType));
}
