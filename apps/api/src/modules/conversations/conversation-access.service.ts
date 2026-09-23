import { Inject, Injectable } from '@nestjs/common';
import type { Principal } from '@ocso/auth';
import { SettingsService, assertConversationAccess, type VisibilityPolicy } from '@ocso/application';
import type { InteractionPart } from '@ocso/domain';
import type { BlobStore } from '@ocso/blob';
import type { Db } from '@ocso/db';
import { BLOB_STORE, DB } from '../../infrastructure/tokens.js';

const MEDIA_URL_TTL_SECONDS = 300;

/** Resource-level checks and media URL signing shared by conversation routes. */
@Injectable()
export class ConversationAccessService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore,
  ) {}

  async policy(): Promise<VisibilityPolicy> {
    const s = await this.settings.deployment();
    return { execsCanViewAiActive: s.execsCanViewAiActive };
  }

  async assert(principal: Principal, conversationId: string): Promise<void> {
    await assertConversationAccess(this.db, principal, conversationId, await this.policy());
  }

  /** Attach short-lived signed URLs to stored media parts (never raw blob keys to browsers). */
  async signParts(parts: readonly InteractionPart[]): Promise<Array<InteractionPart & { url?: string }>> {
    return Promise.all(
      parts.map(async (part) => {
        if (!('media' in part) || part.media.status !== 'STORED' || !part.media.blobKey) return part;
        const url = await this.blobs.signedGetUrl(part.media.blobKey, MEDIA_URL_TTL_SECONDS);
        const { blobKey: _hidden, ...media } = part.media;
        return { ...part, media: media as typeof part.media, url };
      }),
    );
  }
}
