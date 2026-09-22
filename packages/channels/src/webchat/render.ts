import { z } from 'zod';
import { InteractionPart, isMediaPart } from '@ocso/domain';
import type { ChannelCapabilities, RenderedOutbound } from '../contract/types.js';
import { customerSafeParts } from '../contract/render-policy.js';
import { chunkText } from '../common/chunk.js';
import { invalidOutbound } from '../common/errors.js';
import { isMimeAllowed } from '../common/mime.js';

/**
 * Web chat rendering: customer-safe parts pass through as canonical parts
 * (CommonMark text is rendered by the widget). One payload per message;
 * over-long text is split into several TEXT parts. Media must already be in
 * BlobStore — the API hands the widget signed URLs when streaming.
 */

export const WebChatOutboundPayload = z.object({
  type: z.literal('message'),
  parts: z.array(InteractionPart).min(1),
});
export type WebChatOutboundPayload = z.infer<typeof WebChatOutboundPayload>;

function checkMedia(part: InteractionPart, capabilities: ChannelCapabilities): void {
  if (!isMediaPart(part)) return;
  if (part.media.status !== 'STORED' || !part.media.blobKey) {
    throw invalidOutbound('outbound_media_not_stored', 'outbound media must be stored in BlobStore before rendering');
  }
  if (!isMimeAllowed(capabilities, part.type, part.media.mimeType)) {
    throw invalidOutbound('outbound_media_type_not_allowed', `web chat cannot show ${part.type} of this type`);
  }
}

function expand(part: InteractionPart, capabilities: ChannelCapabilities): InteractionPart[] {
  if (part.type !== 'TEXT') return [part];
  return chunkText(part.text, capabilities.maxTextLength).map((text) => ({ type: 'TEXT', text }));
}

export function renderWebChatParts(parts: readonly InteractionPart[], capabilities: ChannelCapabilities): RenderedOutbound[] {
  const safe = new Set(customerSafeParts(parts, capabilities).parts);
  const rendered: InteractionPart[] = [];
  const partIndexes: number[] = [];
  parts.forEach((part, index) => {
    if (!safe.has(part)) return;
    checkMedia(part, capabilities);
    rendered.push(...expand(part, capabilities));
    partIndexes.push(index);
  });
  if (!rendered.length) return [];
  const payload: WebChatOutboundPayload = { type: 'message', parts: rendered };
  return [{ kind: 'WEBCHAT', payload, partIndexes }];
}
