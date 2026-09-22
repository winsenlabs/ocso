import type { InteractionPart, MediaRef } from '@ocso/domain';
import { isDomainError } from '@ocso/domain';
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelKindDescriptor,
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
import { WHATSAPP_CAPABILITIES } from './capabilities.js';
import { WHATSAPP_DESCRIPTOR } from './descriptor.js';
import { resolveWhatsAppConfig, secretValues, validateWhatsAppConfig, type ResolvedWhatsAppConfig } from './config.js';
import { mapGraphFailure, sendFailure } from './errors.js';
import { GraphClient, isSafePathSegment } from './graph-client.js';
import { parseWhatsAppWebhook } from './inbound/parse.js';
import { fetchWhatsAppMedia } from './media.js';
import { renderWhatsAppParts } from './render.js';
import { sendWhatsAppMessage } from './send.js';
import { renderWhatsAppTemplate, type WhatsAppTemplateInput } from './template.js';
import { verifyWhatsAppRequest } from './verification.js';

/**
 * WhatsApp Cloud API channel adapter (ADR-007). Transport only: it never
 * persists, never runs the agent loop and never logs. One instance serves
 * every WhatsApp channel; per-channel settings/secrets arrive with each call.
 */

/** Media resolver for sends that carry no media (templates, text). */
const NO_MEDIA: OutboundMediaResolver = {
  signedUrl: () => Promise.reject(new Error('no media resolver supplied')),
  read: () => Promise.reject(new Error('no media resolver supplied')),
};

export class WhatsAppChannelAdapter implements ChannelAdapter {
  readonly kind = 'WHATSAPP' as const;

  constructor(private readonly deps: ChannelAdapterDeps) {}

  capabilities(_config?: ChannelRuntimeConfig): ChannelCapabilities {
    return WHATSAPP_CAPABILITIES;
  }

  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateWhatsAppConfig(settings, secrets);
  }

  describe(): ChannelKindDescriptor {
    return WHATSAPP_DESCRIPTOR;
  }

  /** Only secrets are needed, so a settings problem never blocks Meta's handshake. */
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
    return verifyWhatsAppRequest(req, { appSecret: config.secrets['appSecret'], verifyToken: config.secrets['verifyToken'] });
  }

  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    const { settings } = resolveWhatsAppConfig(config);
    return parseWhatsAppWebhook(req.rawBody, { businessAccountId: settings.businessAccountId, now: this.deps.now });
  }

  fetchMedia(ref: MediaRef, config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    const resolved = resolveWhatsAppConfig(config);
    return fetchWhatsAppMedia(ref, {
      graph: this.graph(resolved),
      fetch: this.deps.fetch,
      capabilities: this.capabilities(config),
      downloadTimeoutMs: resolved.settings.mediaDownloadTimeoutMs,
    });
  }

  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[] {
    return renderWhatsAppParts(parts, this.capabilities(config));
  }

  async send(
    target: OutboundTarget,
    message: RenderedOutbound,
    config: ChannelRuntimeConfig,
    media: OutboundMediaResolver,
  ): Promise<SendResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return resolved;
    return sendWhatsAppMessage(target, message, {
      config: resolved,
      graph: this.graph(resolved),
      capabilities: this.capabilities(config),
      media,
      now: this.deps.now(),
    });
  }

  /** Build a template payload (for outbox storage) without sending it. */
  renderTemplate(template: WhatsAppTemplateInput): RenderedOutbound {
    return renderWhatsAppTemplate(template);
  }

  /** Send an approved template; allowed outside the 24-hour window. */
  async sendTemplate(
    target: OutboundTarget,
    template: WhatsAppTemplateInput,
    config: ChannelRuntimeConfig,
  ): Promise<SendResult> {
    let rendered: RenderedOutbound;
    try {
      rendered = renderWhatsAppTemplate(template);
    } catch (error) {
      return sendFailure('invalid_template', isDomainError(error) ? error.message : 'invalid WhatsApp template');
    }
    return this.send(target, rendered, config, NO_MEDIA);
  }

  /** Mark an inbound message read (blue ticks), optionally showing a typing indicator (~25 s). */
  async markRead(
    inboundExternalId: string,
    config: ChannelRuntimeConfig,
    options: { channelAccountId?: string | undefined; typingIndicator?: boolean | undefined } = {},
  ): Promise<SendResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return resolved;
    const phoneNumberId = options.channelAccountId ?? resolved.settings.phoneNumberId;
    if (!isSafePathSegment(phoneNumberId)) return sendFailure('invalid_channel_account', 'invalid WhatsApp phone number id');
    const result = await this.graph(resolved).postJson([phoneNumberId, 'messages'], {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: inboundExternalId,
      ...(options.typingIndicator ? { typing_indicator: { type: 'text' } } : {}),
    });
    return result.kind === 'ok'
      ? { ok: true, externalMessageId: inboundExternalId }
      : mapGraphFailure(result, secretValues(resolved));
  }

  private graph(config: ResolvedWhatsAppConfig): GraphClient {
    return new GraphClient({
      baseUrl: config.settings.graphBaseUrl,
      version: config.settings.graphApiVersion,
      accessToken: config.secrets.accessToken,
      timeoutMs: config.settings.requestTimeoutMs,
      fetch: this.deps.fetch,
    });
  }

  private tryResolve(config: ChannelRuntimeConfig): ResolvedWhatsAppConfig | Extract<SendResult, { ok: false }> {
    try {
      return resolveWhatsAppConfig(config);
    } catch (error) {
      return sendFailure('invalid_channel_config', isDomainError(error) ? error.message : 'invalid channel configuration');
    }
  }
}

export function createWhatsAppAdapter(deps: Partial<ChannelAdapterDeps> = {}): WhatsAppChannelAdapter {
  return new WhatsAppChannelAdapter({
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    now: deps.now ?? (() => new Date()),
  });
}
