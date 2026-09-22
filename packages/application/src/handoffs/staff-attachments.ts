import { validation, type InteractionPart } from '@ocso/domain';

/** Staff uploads for a conversation live under this prefix; replies may only reference these keys. */
export const staffAttachmentPrefix = (conversationId: string) => `staff/${conversationId}/`;

export interface StoredMediaLookup {
  head(key: string): Promise<{ contentType: string; sizeBytes: number } | null>;
}

/**
 * Staff replies must only send media OCSO stored for this conversation
 * (docs/15: no cross-conversation data exposure). Client-supplied metadata is
 * replaced with what the blob store actually holds.
 */
export async function verifyStaffMedia(parts: readonly InteractionPart[], conversationId: string, media: StoredMediaLookup | undefined): Promise<InteractionPart[]> {
  const prefix = staffAttachmentPrefix(conversationId);
  const out: InteractionPart[] = [];
  for (const part of parts) {
    if (!('media' in part)) {
      out.push(part);
      continue;
    }
    const key = part.media.blobKey;
    if (!media || !key || !key.startsWith(prefix) || key.includes('..')) throw validation('attachment_not_allowed', 'Attach files by uploading them to this conversation first');
    const stored = await media.head(key);
    if (!stored) throw validation('attachment_not_found', 'The attachment is no longer available; upload it again');
    out.push({
      ...part,
      media: { blobKey: key, mimeType: stored.contentType, sizeBytes: stored.sizeBytes, status: 'STORED', ...(part.media.filename ? { filename: part.media.filename } : {}) },
    } as InteractionPart);
  }
  return out;
}
