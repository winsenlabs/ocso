import { z } from 'zod';
import type { InteractionPart, MediaRef } from '@ocso/domain';
import type { ChannelCapabilities, MediaKind } from '../contract/types.js';
import { invalidInbound } from '../common/errors.js';
import { mediaKindForMime } from '../common/mime.js';
import { clip } from '../common/text.js';
import { identityDigest, type WebChatIdentity } from './identity.js';

/**
 * Web chat attachments are uploaded by the OCSO API into BlobStore before the
 * message is posted, so parts arrive already `STORED`. To stop one visitor
 * referencing another's upload (IDOR), the API must store uploads under
 * `attachmentKeyPrefix(channelId, identity)`; parsing rejects any other key.
 */

export const WebChatAttachment = z
  .object({
    blobKey: z.string().min(1).max(512).optional(),
    /** Alias accepted from the widget: the key returned by the upload endpoint. */
    uploadId: z.string().min(1).max(512).optional(),
    mimeType: z.string().min(1).max(255),
    filename: z.string().max(1_000).optional(),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  })
  .refine((a) => Boolean(a.blobKey) !== Boolean(a.uploadId), 'exactly one of blobKey or uploadId is required');
export type WebChatAttachment = z.infer<typeof WebChatAttachment>;

export function attachmentKeyPrefix(
  channelId: string,
  identity: Pick<WebChatIdentity, 'identityKind' | 'identityValue'>,
): string {
  return `webchat/${channelId}/${identityDigest(identity)}/`;
}

const MEDIA_PART: Readonly<Record<MediaKind, (media: MediaRef) => InteractionPart>> = {
  IMAGE: (media) => ({ type: 'IMAGE', media }),
  AUDIO: (media) => ({ type: 'AUDIO', media }),
  VIDEO: (media) => ({ type: 'VIDEO', media }),
  DOCUMENT: (media) => ({ type: 'DOCUMENT', media }),
};

/** Strip path components and control characters from a user-supplied filename. */
function safeFilename(name: string | undefined): string | undefined {
  const base = name?.split(/[/\\]/).pop()?.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base ? clip(base, 255) : undefined;
}

export function attachmentToPart(
  attachment: WebChatAttachment,
  ctx: { capabilities: ChannelCapabilities; keyPrefix: string },
): InteractionPart {
  const blobKey = attachment.blobKey ?? attachment.uploadId ?? '';
  if (!blobKey.startsWith(ctx.keyPrefix) || blobKey.includes('..')) {
    throw invalidInbound('webchat_attachment_not_owned', 'attachment does not belong to this visitor');
  }
  const kind = mediaKindForMime(ctx.capabilities, attachment.mimeType);
  if (!kind || !ctx.capabilities.inboundParts.includes(kind)) {
    throw invalidInbound('webchat_attachment_type_not_allowed', 'attachment type is not allowed', {
      mimeType: attachment.mimeType,
    });
  }
  const limit = ctx.capabilities.maxMediaBytes[kind];
  if (attachment.sizeBytes > limit) {
    throw invalidInbound('webchat_attachment_too_large', `attachment exceeds ${limit} bytes`, { limitBytes: limit });
  }
  const filename = safeFilename(attachment.filename);
  const media: MediaRef = {
    status: 'STORED',
    blobKey,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    source: { channel: 'WEBCHAT' },
    ...(attachment.sha256 ? { sha256: attachment.sha256.toLowerCase() } : {}),
    ...(filename ? { filename } : {}),
  };
  return MEDIA_PART[kind](media);
}
