import { z } from 'zod';
import type { ChannelCapabilities, OutboundMediaResolver } from '../contract/types.js';
import { baseMimeType } from '../common/mime.js';
import { outboundMimeAllowed } from './capabilities.js';
import { mapGraphFailure, sendFailure, type SendFailure } from './errors.js';
import type { GraphClient } from './graph-client.js';
import type { WhatsAppMediaPayload } from './payload.js';

/**
 * Resolve a BlobStore reference into something Meta can use:
 * - `link` mode: a short-lived signed HTTPS URL Meta downloads itself;
 * - `upload` mode: bytes are uploaded to `/{phone-number-id}/media` and the
 *   returned media id is used (works when blob storage is not internet-facing).
 */

export type MediaObjectSource = { id: string } | { link: string };

export interface OutboundMediaContext {
  mode: 'link' | 'upload';
  linkTtlSeconds: number;
  phoneNumberId: string;
  graph: GraphClient;
  capabilities: ChannelCapabilities;
  resolver: OutboundMediaResolver;
  secrets: readonly string[];
}

const KIND = { image: 'IMAGE', audio: 'AUDIO', video: 'VIDEO', document: 'DOCUMENT' } as const;
const UploadResponse = z.object({ id: z.string().min(1) });

async function signedLink(payload: WhatsAppMediaPayload, ctx: OutboundMediaContext): Promise<MediaObjectSource | SendFailure> {
  let link: string;
  try {
    link = await ctx.resolver.signedUrl(payload.blobKey, ctx.linkTtlSeconds);
  } catch {
    return sendFailure('media_unavailable', 'could not create a signed URL for outbound media', true);
  }
  return URL.canParse(link) ? { link } : sendFailure('media_unavailable', 'signed media URL is not a valid URL');
}

async function upload(payload: WhatsAppMediaPayload, ctx: OutboundMediaContext): Promise<MediaObjectSource | SendFailure> {
  let file: Awaited<ReturnType<OutboundMediaResolver['read']>>;
  try {
    file = await ctx.resolver.read(payload.blobKey);
  } catch {
    return sendFailure('media_unavailable', 'could not read outbound media from blob storage', true);
  }
  const kind = KIND[payload.mediaType];
  if (file.data.byteLength > ctx.capabilities.maxMediaBytes[kind]) {
    return sendFailure('media_too_large', `${kind} exceeds the WhatsApp size limit`);
  }
  if (!outboundMimeAllowed(kind, file.mimeType, ctx.capabilities)) {
    return sendFailure('media_type_not_allowed', `WhatsApp cannot send ${kind} as ${baseMimeType(file.mimeType)}`);
  }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', file.mimeType);
  form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mimeType }), file.filename ?? payload.filename ?? 'file');
  const result = await ctx.graph.postForm([ctx.phoneNumberId, 'media'], form);
  if (result.kind !== 'ok') return mapGraphFailure(result, ctx.secrets);
  const parsed = UploadResponse.safeParse(result.body);
  return parsed.success ? { id: parsed.data.id } : sendFailure('provider_error', 'media upload returned no media id', true);
}

export function resolveOutboundMedia(
  payload: WhatsAppMediaPayload,
  ctx: OutboundMediaContext,
): Promise<MediaObjectSource | SendFailure> {
  return ctx.mode === 'upload' ? upload(payload, ctx) : signedLink(payload, ctx);
}
