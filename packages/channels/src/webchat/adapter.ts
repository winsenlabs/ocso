import { randomUUID } from 'node:crypto';
import type { InteractionPart, MediaRef } from '@ocso/domain';
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelCapabilities,
  ChannelRuntimeConfig,
  FetchedMedia,
  InboundEnvelope,
  OutboundMediaResolver,
  OutboundTarget,
  RawHttpRequest,
  RenderedOutbound,
  SendResult,
  VerificationResult,
} from '../contract/types.js';
import type { ChannelKindDescriptor } from '../contract/descriptor.js';
import type { EmbeddedChat } from '../contract/embed.js';
import { ChannelMediaError } from '../common/errors.js';
import { attachmentKeyPrefix } from './attachments.js';
import { webChatCapabilities } from './capabilities.js';
import { WEBCHAT_DESCRIPTOR } from './descriptor.js';
import { resolveWebChatConfig, validateWebChatConfig, type ResolvedWebChatConfig } from './config.js';
import { webChatEmbed } from './embed.js';
import { WebChatAuthError } from './errors.js';
import { identifyRequest, WEBCHAT_IDENTITY, type WebChatIdentity } from './identity.js';
import { parseWebChatInbound } from './inbound.js';
import { renderWebChatParts, WebChatOutboundPayload } from './render.js';
import { issueVisitorToken, type IssuedVisitorToken } from './visitor-token.js';

/**
 * OCSO's first-party web chat (ADR-007: our endpoints + AI SDK UI widget).
 * Inbound arrives as JSON from the widget via the OCSO API; the caller is
 * authenticated by a channel-bound visitor token or a host-app JWT.
 *
 * `send` performs NO network I/O: web chat delivery is the realtime stream
 * (outbox -> LISTEN/NOTIFY -> SSE, ADR-009). It validates the payload and
 * returns a generated id so the outbox row and delivery status stay uniform
 * across channels.
 */

export interface WebChatAdapterDeps {
  now: () => Date;
  generateId: () => string;
}

const WEBCHAT_IDENTITY_KINDS: ReadonlySet<string> = new Set(Object.values(WEBCHAT_IDENTITY));

export class WebChatChannelAdapter implements ChannelAdapter {
  readonly kind = 'WEBCHAT' as const;
  /** The public widget protocol OCSO's `/public/webchat/<publicKey>/*` API speaks. */
  readonly embed: EmbeddedChat;

  constructor(private readonly deps: WebChatAdapterDeps) {
    this.embed = webChatEmbed(deps.now);
  }

  capabilities(config?: ChannelRuntimeConfig): ChannelCapabilities {
    return webChatCapabilities(config?.settings);
  }

  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateWebChatConfig(settings, secrets);
  }

  describe(): ChannelKindDescriptor {
    return WEBCHAT_DESCRIPTOR;
  }

  /** Anonymous visitors show as "web · sess 8f2a"; host-identified customers keep the generic masking. */
  displayIdentity(identityKind: string, value: string): string | null {
    return identityKind === WEBCHAT_IDENTITY.VISITOR ? `web · sess ${value.slice(-4)}` : null;
  }

  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
    let resolved: ResolvedWebChatConfig;
    try {
      resolved = resolveWebChatConfig(config);
    } catch {
      return { kind: 'rejected', status: 403, reason: 'channel is not configured' };
    }
    try {
      identifyRequest(req, resolved, this.deps.now());
      return { kind: 'verified' };
    } catch (error) {
      if (error instanceof WebChatAuthError) return { kind: 'rejected', status: error.status, reason: error.message };
      throw error;
    }
  }

  /** Resolve the authenticated caller (also used by the API's upload and stream endpoints). */
  identify(req: RawHttpRequest, config: ChannelRuntimeConfig): WebChatIdentity {
    return identifyRequest(req, resolveWebChatConfig(config), this.deps.now());
  }

  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    const resolved = resolveWebChatConfig(config);
    const now = this.deps.now();
    return parseWebChatInbound(req.rawBody, {
      config: resolved,
      capabilities: this.capabilities(config),
      identity: identifyRequest(req, resolved, now),
      now,
    });
  }

  /** Attachments are uploaded straight into BlobStore by the API; there is nothing to fetch. */
  fetchMedia(_ref: MediaRef, _config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    return Promise.reject(
      new ChannelMediaError('not_applicable', 'web chat media is uploaded to blob storage directly; nothing to fetch'),
    );
  }

  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[] {
    return renderWebChatParts(parts, this.capabilities(config));
  }

  async send(
    target: OutboundTarget,
    message: RenderedOutbound,
    _config: ChannelRuntimeConfig,
    _media: OutboundMediaResolver,
  ): Promise<SendResult> {
    if (message.kind !== 'WEBCHAT' || !WebChatOutboundPayload.safeParse(message.payload).success) {
      return { ok: false, errorCode: 'invalid_payload', message: 'message is not a valid web chat payload', retriable: false };
    }
    if (!WEBCHAT_IDENTITY_KINDS.has(target.identityKind)) {
      return { ok: false, errorCode: 'invalid_recipient', message: 'recipient is not a web chat identity', retriable: false };
    }
    return { ok: true, externalMessageId: `webchat-out:${this.deps.generateId()}` };
  }

  /** Issue a channel-bound visitor token (new visitor, renewal, or after host-JWT verification). */
  issueVisitorToken(
    config: ChannelRuntimeConfig,
    input: { visitorId?: string | undefined; externalCustomerRef?: string | undefined; ttlSeconds?: number | undefined } = {},
  ): IssuedVisitorToken {
    const resolved = resolveWebChatConfig(config);
    return issueVisitorToken(
      {
        channelId: resolved.channelId,
        visitorId: input.visitorId,
        externalCustomerRef: input.externalCustomerRef,
        ttlSeconds: Math.min(input.ttlSeconds ?? resolved.settings.visitorTokenTtlSeconds, resolved.settings.visitorTokenTtlSeconds),
      },
      resolved.visitorTokenSecret,
      this.deps.now(),
    );
  }

  /** BlobStore key prefix the API must use when storing this caller's uploads. */
  attachmentKeyPrefix(config: ChannelRuntimeConfig, identity: Pick<WebChatIdentity, 'identityKind' | 'identityValue'>): string {
    return attachmentKeyPrefix(config.id, identity);
  }
}

/** Accepts the common channel deps for uniform wiring; `fetch` is unused (no network I/O). */
export function createWebChatAdapter(
  deps: Partial<ChannelAdapterDeps> & Partial<Pick<WebChatAdapterDeps, 'generateId'>> = {},
): WebChatChannelAdapter {
  return new WebChatChannelAdapter({
    now: deps.now ?? (() => new Date()),
    generateId: deps.generateId ?? randomUUID,
  });
}
