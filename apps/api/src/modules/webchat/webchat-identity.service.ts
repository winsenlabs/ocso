import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { ChannelRuntime } from '@ocso/agent-runtime';
import type { ChannelAdapter, ChannelRegistry, ChannelRuntimeConfig, EmbeddedChat, EmbedVisitor } from '@ocso/channels';
import type { ApiEnv } from '@ocso/config';
import { notFound } from '@ocso/domain';
import { channels, conversations, virtualAgents, type Db } from '@ocso/db';
import { lookupCustomer, passThroughAgentOf } from '@ocso/application';
import { CHANNEL_REGISTRY, DB, ENV } from '../../infrastructure/tokens.js';
import { assertOriginAllowed } from './webchat-access.js';

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
/** One channel load per HTTP request (the CORS middleware and the handler share it; secrets are resolved once). */
const perRequest = new WeakMap<object, { publicKey: string; ctx: Promise<WebChatContext> }>();

@Injectable()
export class WebChatIdentityService {
  private readonly publicOrigin: string;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ChannelRuntime) private readonly runtime: ChannelRuntime,
    @Inject(CHANNEL_REGISTRY) private readonly registry: ChannelRegistry,
    @Inject(ENV) env: ApiEnv,
  ) {
    this.publicOrigin = new URL(env.OCSO_PUBLIC_URL).origin;
  }

  /** `channel()` memoized for one request object. */
  channelForRequest(req: object, publicKey: string): Promise<WebChatContext> {
    const hit = perRequest.get(req);
    if (hit && hit.publicKey === publicKey) return hit.ctx;
    const ctx = this.channel(publicKey);
    perRequest.set(req, { publicKey, ctx });
    // A failed load is not cached beyond this request's own retry.
    ctx.catch(() => perRequest.delete(req));
    return ctx;
  }

  /**
   * The channel behind a public call, with the caller admitted: browser calls from OCSO itself or an allowed
   * site; calls without an Origin only when native apps are allowed or the auth mode needs a pass or user.
   */
  async access(req: object, publicKey: string, origin: string | undefined): Promise<WebChatContext> {
    const ctx = await this.channelForRequest(req, publicKey);
    const effective = origin ?? this.sameOriginFallback(req);
    assertOriginAllowed(effective, this.publicOrigin, ctx.embed.widgetConfig(ctx.config));
    return ctx;
  }

  /**
   * Browsers send no Origin on same-origin GETs (the widget iframe's history and stream). Most send
   * Sec-Fetch-Site; Safari before 16.4 does not, so without it the Referer (the widget page on OCSO's own
   * origin) decides. A non-browser can forge any of these headers, as it can forge Origin: this rule steers
   * browsers and honest apps, the tokens are the security boundary.
   */
  private sameOriginFallback(req: object): string | undefined {
    const headers = (req as { headers?: Record<string, string | string[] | undefined> }).headers ?? {};
    const fetchSite = headers['sec-fetch-site'];
    if (fetchSite !== undefined) return fetchSite === 'same-origin' ? this.publicOrigin : undefined;
    const referer = headers['referer'];
    if (typeof referer !== 'string') return undefined;
    try {
      return new URL(referer).origin === this.publicOrigin ? this.publicOrigin : undefined;
    } catch {
      return undefined;
    }
  }

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

  identify(ctx: WebChatContext, authorization: string | undefined): Promise<EmbedVisitor> {
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
   * The customer this caller maps to, with the same rules as inbound resolution (packages/application
   * identity-resolver `lookupCustomer`): the primary identity's customer, else an alternate's — so a guest who
   * is then identified by the host site keeps seeing the conversation their next message will join. A verified
   * user never falls back to an alternate that belongs to a different verified user (a shared browser).
   */
  customerIdFor(identity: EmbedVisitor): Promise<string | null> {
    return lookupCustomer(this.db, {
      primary: { kind: identity.identityKind, value: identity.identityValue },
      alternates: identity.alternateIdentities,
      primaryVerified: identity.verified,
    });
  }
}
