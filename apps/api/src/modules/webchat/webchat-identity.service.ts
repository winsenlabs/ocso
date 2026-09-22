import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ChannelRuntime } from '@ocso/agent-runtime';
import {
  identifyToken,
  resolveWebChatConfig,
  type ChannelAdapter,
  type ChannelRuntimeConfig,
  type WebChatIdentity,
} from '@ocso/channels';
import { DomainError, notFound } from '@ocso/domain';
import { channels, conversations, customerIdentities, virtualAgents, type Db } from '@ocso/db';
import { DB } from '../../infrastructure/tokens.js';

export interface WebChatContext {
  adapter: ChannelAdapter;
  config: ChannelRuntimeConfig;
  row: typeof channels.$inferSelect;
}

/** Resolves web-chat channels by public key and visitors to their conversation. */
@Injectable()
export class WebChatIdentityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
  ) {}

  async channel(publicKey: string): Promise<WebChatContext> {
    const [row] = await this.db.select({ id: channels.id, kind: channels.kind, status: channels.status }).from(channels).where(eq(channels.publicKey, publicKey));
    if (!row || row.kind !== 'WEBCHAT' || row.status !== 'ACTIVE') throw notFound('channel', publicKey);
    return this.runtime.load(row.id);
  }

  identify(ctx: WebChatContext, authorization: string | undefined): WebChatIdentity {
    const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new DomainError('authentication', 'webchat_token_missing', 'Visitor token required');
    return identifyToken(token, resolveWebChatConfig(ctx.config), new Date());
  }

  /** The visitor's latest conversation on this channel, if any. */
  async conversationFor(channelId: string, identity: WebChatIdentity): Promise<{ id: string; customerId: string; agentName: string; controlState: string } | null> {
    const [row] = await this.db
      .select({ id: conversations.id, customerId: conversations.customerId, agentName: virtualAgents.name, controlState: conversations.controlState })
      .from(customerIdentities)
      .innerJoin(conversations, and(eq(conversations.customerId, customerIdentities.customerId), eq(conversations.channelId, channelId)))
      .innerJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId))
      .where(and(eq(customerIdentities.kind, identity.identityKind), eq(customerIdentities.value, identity.identityValue)))
      .orderBy(desc(conversations.lastInteractionAt))
      .limit(1);
    return row ?? null;
  }

  async customerIdFor(identity: WebChatIdentity): Promise<string | null> {
    const [row] = await this.db
      .select({ customerId: customerIdentities.customerId })
      .from(customerIdentities)
      .where(and(eq(customerIdentities.kind, identity.identityKind), eq(customerIdentities.value, identity.identityValue)));
    return row?.customerId ?? null;
  }
}
