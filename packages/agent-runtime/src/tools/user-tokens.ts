import { heldUserTokenFor } from '@ocso/application';
import type { Db } from '@ocso/db';
import type { ChannelRuntime } from '../delivery/channel-runtime.js';

/** The customer's verified end-user token for a conversation, when its channel holds one (tool identity passthrough). */
export interface UserTokenSource {
  forConversation(conversationId: string): Promise<string | null>;
}

/**
 * Reads the newest live held token of the conversation's customer on its
 * channel and asks the channel kind to open it (the key never leaves the
 * kind: it is derived from the channel's own secret). Null when there is
 * none, it expired, or it can no longer be opened (e.g. the key was rotated).
 */
export class HeldUserTokenSource implements UserTokenSource {
  constructor(
    private readonly db: Db,
    private readonly channels: Pick<ChannelRuntime, 'load'>,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async forConversation(conversationId: string): Promise<string | null> {
    const held = await heldUserTokenFor(this.db, conversationId, this.now());
    if (!held) return null;
    const { adapter, config } = await this.channels.load(held.channelId);
    return adapter.embed?.openUserToken?.(config, held.sealed) ?? null;
  }
}
