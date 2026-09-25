import { and, eq } from 'drizzle-orm';
import type { InteractionPart, MediaRef } from '@ocso/domain';
import { interactionParts, interactions, uuidv7, type Db } from '@ocso/db';
import { checkMedia, extensionFor, mediaKey, type BlobStore } from '@ocso/blob';
import type { MediaKind } from '@ocso/channels';
import type { ChannelRuntime } from './channel-runtime.js';

/**
 * Materialize inbound media (docs/archive/specs/07 §6): fetch via the channel adapter,
 * validate by sniffed content + size, store in BlobStore, update the part.
 * Idempotent: parts already STORED/REJECTED are left alone.
 */
export class MediaMaterializer {
  constructor(
    private readonly db: Db,
    private readonly channels: ChannelRuntime,
    private readonly blobs: BlobStore,
  ) {}

  async materialize(interactionId: string, partIdx: number): Promise<'stored' | 'rejected' | 'skipped' | 'retry'> {
    const [part] = await this.db
      .select()
      .from(interactionParts)
      .where(and(eq(interactionParts.interactionId, interactionId), eq(interactionParts.idx, partIdx)));
    const content = part?.content as unknown as InteractionPart | undefined;
    if (!part || !content || !('media' in content) || content.media.status !== 'PENDING') return 'skipped';
    const [interaction] = await this.db.select().from(interactions).where(eq(interactions.id, interactionId));
    if (!interaction?.channelId) return 'skipped';
    const { adapter, config } = await this.channels.load(interaction.channelId);
    const caps = adapter.capabilities(config);
    const kind = content.type as MediaKind;
    let media: MediaRef;
    try {
      const fetched = await adapter.fetchMedia(content.media, config);
      const check = checkMedia(fetched.data, fetched.mimeType, caps.allowedMimeTypes[kind] ?? [], caps.maxMediaBytes[kind] ?? 0);
      if (!check.ok) {
        media = { ...content.media, status: 'REJECTED', rejectionReason: check.reason };
      } else {
        const key = mediaKey(interaction.conversationId, uuidv7(), extensionFor(check.mimeType));
        const stored = await this.blobs.put({ key, data: fetched.data, contentType: check.mimeType, retention: 'CONVERSATION_MEDIA' });
        media = { ...content.media, status: 'STORED', blobKey: stored.key, mimeType: check.mimeType, sizeBytes: stored.sizeBytes, sha256: stored.sha256, ...(fetched.filename ? { filename: fetched.filename } : {}) };
      }
    } catch (err) {
      const e = err as { rejected?: boolean; retriable?: boolean };
      if (e.retriable) return 'retry';
      media = { ...content.media, status: e.rejected ? 'REJECTED' : 'FAILED', rejectionReason: 'fetch_failed' };
    }
    const updated = { ...content, media } as InteractionPart;
    await this.db
      .update(interactionParts)
      .set({ content: updated as unknown as Record<string, unknown>, blobKey: media.blobKey ?? null, mediaStatus: media.status })
      .where(eq(interactionParts.id, part.id));
    return media.status === 'STORED' ? 'stored' : 'rejected';
  }

  /** Materialize all pending media of the given interactions (used before a turn). */
  async materializeAll(interactionIds: readonly string[]): Promise<void> {
    for (const id of interactionIds) {
      const parts = await this.db.select().from(interactionParts).where(and(eq(interactionParts.interactionId, id), eq(interactionParts.mediaStatus, 'PENDING')));
      for (const p of parts) await this.materialize(id, p.idx);
    }
  }
}
