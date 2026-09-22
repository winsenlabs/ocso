import { z } from 'zod';
import type { MediaRef } from '@ocso/domain';
import type { ChannelCapabilities, FetchedMedia } from '../contract/types.js';
import { normalizeSha256, sha256Hex } from '../common/crypto.js';
import { ChannelMediaError, type MediaErrorReason } from '../common/errors.js';
import { mediaKindForMime } from '../common/mime.js';
import { isSafePathSegment, type GraphClient, type GraphResult } from './graph-client.js';
import { downloadMedia } from './media-download.js';

/**
 * Inbound media fetch (PM/research/02 §5): GET /{media-id} for a short-lived
 * URL (valid ~5 minutes), then download it. Enforces the MIME allowlist and
 * per-kind size limits from capabilities (declared size, Content-Length and
 * streamed byte count), and verifies sha256 against every digest Meta gave.
 */

const MediaInfo = z.object({
  url: z.string().min(1),
  mime_type: z.string().min(1).optional(),
  sha256: z.string().optional(),
  file_size: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)]).optional(),
});
type MediaInfo = z.infer<typeof MediaInfo>;

export interface MediaFetchContext {
  graph: GraphClient;
  fetch: typeof fetch;
  capabilities: ChannelCapabilities;
  downloadTimeoutMs: number;
}

function mediaIdOf(ref: MediaRef): string {
  const id = ref.source?.externalId;
  if (ref.source?.channel !== 'WHATSAPP' || !id || !isSafePathSegment(id)) {
    throw new ChannelMediaError('invalid_reference', 'media reference is not a WhatsApp media id');
  }
  return id;
}

function lookupFailure(result: Exclude<GraphResult, { kind: 'ok' }>): ChannelMediaError {
  if (result.kind === 'network') {
    return result.timedOut
      ? new ChannelMediaError('timeout', 'media lookup timed out')
      : new ChannelMediaError('download_failed', 'media lookup failed before a response');
  }
  return new ChannelMediaError(lookupReason(result.status, result.error.code), `media lookup failed with HTTP ${result.status}`, {
    status: result.status,
    metaCode: result.error.code ?? null,
  });
}

function lookupReason(status: number, metaCode: number | undefined): MediaErrorReason {
  // Code 100 on /{media-id}: unknown or expired id (inbound ids live ~7 days).
  if (status === 404 || metaCode === 100) return 'not_found';
  if (status === 401 || metaCode === 190) return 'auth_failed';
  if (status === 429 || metaCode === 130429 || metaCode === 4) return 'rate_limited';
  return 'download_failed';
}

async function lookup(mediaId: string, graph: GraphClient): Promise<MediaInfo> {
  const result = await graph.getJson(mediaId);
  if (result.kind !== 'ok') throw lookupFailure(result);
  const info = MediaInfo.safeParse(result.body);
  if (!info.success) throw new ChannelMediaError('download_failed', 'media lookup returned an unexpected body');
  return info.data;
}

function verifyChecksums(actual: string, expected: ReadonlyArray<string | undefined>): void {
  for (const digest of expected) {
    const normalized = normalizeSha256(digest);
    if (normalized && normalized !== actual) {
      throw new ChannelMediaError('checksum_mismatch', 'media sha256 does not match the provider digest');
    }
  }
}

export async function fetchWhatsAppMedia(ref: MediaRef, ctx: MediaFetchContext): Promise<FetchedMedia> {
  const mediaId = mediaIdOf(ref);
  const info = await lookup(mediaId, ctx.graph);
  const mimeType = info.mime_type ?? ref.mimeType;
  const kind = mediaKindForMime(ctx.capabilities, mimeType);
  if (!kind) throw new ChannelMediaError('type_not_allowed', 'media type is not allowed on this channel', { mimeType });
  const limitBytes = ctx.capabilities.maxMediaBytes[kind];
  const declared = Math.max(info.file_size ?? 0, ref.sizeBytes ?? 0);
  if (declared > limitBytes) {
    throw new ChannelMediaError('too_large', `media exceeds ${limitBytes} bytes`, { declaredBytes: declared, kind });
  }
  const data = await downloadMedia(info.url, {
    fetch: ctx.fetch,
    accessToken: ctx.graph.accessToken,
    graphOrigin: ctx.graph.origin,
    limitBytes,
    timeoutMs: ctx.downloadTimeoutMs,
    expectedMimeType: mimeType,
  });
  const sha256 = sha256Hex(data);
  verifyChecksums(sha256, [ref.sha256, info.sha256]);
  return { data, mimeType, sizeBytes: data.byteLength, sha256, filename: ref.filename };
}
