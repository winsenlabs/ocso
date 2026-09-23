import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, or } from 'drizzle-orm';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelAdapter, ChannelRegistry, ChannelRuntimeConfig, EmbeddedChat, EmbedVisitor } from '@ocso/channels';
import { notFound } from '@ocso/domain';
import { channels, conversations, customerIdentities, virtualAgents, type Db } from '@ocso/db';
import { passThroughAgentOf } from '@ocso/application';
import { CHANNEL_REGISTRY, DB } from '../../infrastructure/tokens.js';

export interface VisitorConversation {
  id: string;
  customerId: string;
  /** Null while a router is still deciding (ROUTING). */
  agentName: string | null;
  controlState: string;
  assignedUserId: string | null;
}

export interface WebChatContext {
  adapter: ChannelAdapter;
  /** The kind's widget protocol (visitor tokens, identity, widget settings). */
  embed: EmbeddedChat;
  config: ChannelRuntimeConfig;
  row: typeof channels.$inferSelect;
}

/**
 * Resolves embeddable channels by public key and visitors to their
 * conversation. Any kind whose descriptor is `embeddable` is served by the
 * public widget API; the adapter's `embed` hooks do the kind-specific part.
 */
@Injectable()
export class WebChatIdentityService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
  ) {}

  async channel(publicKey: string): Promise<WebChatContext> {
    const [row] = await this.db.select({ id: channels.id, kind: channels.kind, status: channels.status }).from(channels).where(eq(channels.publicKey, publicKey));
    const embed = row ? this.registry.embed(row.kind) : null;
    if (!row || !embed || row.status !== 'ACTIVE') throw notFound('channel', publicKey);
    return { ...(await this.runtime.load(row.id)), embed };
  }

  /**
   * The assistant a new visitor talks to: the agent of the channel's
   * pass-through router (its queue's agent). A router that asks first has no
   * single assistant yet, so the widget shows the generic label.
   */
  async assistantName(ctx: WebChatContext): Promise<string | null> {
    const agentId = (await passThroughAgentOf(this.db, [ctx.row.id])).get(ctx.row.id);
    if (!agentId) return null;
    const [row] = await this.db.select({ name: virtualAgents.name }).from(virtualAgents).where(eq(virtualAgents.id, agentId));
    return row?.name ?? null;
  }

  identify(ctx: WebChatContext, authorization: string | undefined): EmbedVisitor {
    return ctx.embed.identify(ctx.config, /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]);
  }

  /** The visitor's latest conversation on this channel, if any. */
  async conversationFor(channelId: string, identity: EmbedVisitor): Promise<VisitorConversation | null> {
    const customerId = await this.customerIdFor(identity);
    if (!customerId) return null;
    const [row] = await this.db
      .select({
        id: conversations.id,
        customerId: conversations.customerId,
        agentName: virtualAgents.name,
        controlState: conversations.controlState,
        assignedUserId: conversations.assignedUserId,
      })
      .from(conversations)
      .leftJoin(virtualAgents, eq(virtualAgents.id, conversations.agentId))
      .where(and(eq(conversations.customerId, customerId), eq(conversations.channelId, channelId)))
      .orderBy(desc(conversations.lastInteractionAt))
      .limit(1);
    return row ?? null;
  }

  /**
   * The customer this caller maps to, with the same precedence as inbound
   * resolution (packages/application identity-resolver): the primary identity's
   * customer, else an alternate's — so a guest who is then identified by the
   * host site keeps seeing the conversation their next message will join.
   */
  async customerIdFor(identity: EmbedVisitor): Promise<string | null> {
    const claims = [{ kind: identity.identityKind, value: identity.identityValue }, ...identity.alternateIdentities];
    const rows = await this.db
      .select({ kind: customerIdentities.kind, value: customerIdentities.value, customerId: customerIdentities.customerId })
      .from(customerIdentities)
      .where(or(...claims.map((c) => and(eq(customerIdentities.kind, c.kind), eq(customerIdentities.value, c.value)))));
    const primary = rows.find((r) => r.kind === identity.identityKind && r.value === identity.identityValue);
    const alternate = identity.alternateIdentities.map((a) => rows.find((r) => r.kind === a.kind && r.value === a.value)).find(Boolean);
    return primary?.customerId ?? alternate?.customerId ?? null;
  }
}
