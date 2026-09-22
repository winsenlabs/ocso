import type { InteractionPart, MediaRef, MessageTemplate, TemplateDraft } from '@ocso/domain';
import { isDomainError } from '@ocso/domain';
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelCapabilities,
  ChannelKindDescriptor,
  ChannelRuntimeConfig,
  ConnectionCheckResult,
  FetchedMedia,
  InboundEnvelope,
  OutboundMediaResolver,
  OutboundTarget,
  RawHttpRequest,
  RenderedOutbound,
  SendResult,
  TemplateSendRequest,
  VerificationResult,
  WebhookAcknowledgement,
} from '../contract/types.js';
import { TemplateProviderError } from '../common/templates.js';
import { TWILIO_WHATSAPP_CAPABILITIES } from './capabilities.js';
import { resolveTwilioConfig, validateTwilioWhatsAppConfig, type ResolvedTwilioConfig } from './config.js';
import { checkTwilioConnection } from './connection-check.js';
import { TWILIO_WHATSAPP_DESCRIPTOR } from './descriptor.js';
import { sendFailure, type SendFailure } from './errors.js';
import { parseTwilioWebhook } from './inbound/parse.js';
import { fetchTwilioMedia } from './media.js';
import { renderTwilioParts } from './render.js';
import { TwilioRestClient } from './rest-client.js';
import { sendTwilioMessage } from './send.js';
import { verifyTwilioSignature } from './signature.js';
import { renderTwilioTemplate, type TwilioTemplateInput } from './template.js';
import { TwilioTemplates } from './templates/api.js';

/**
 * WhatsApp through Twilio Programmable Messaging (PM/research/06). Transport
 * only: it never persists, never runs the agent loop and never logs. One
 * instance serves every Twilio WhatsApp channel; per-channel settings and
 * secrets arrive with each call.
 */

/** Empty TwiML: "received, no reply" — replies go out through the Messages API. */
const EMPTY_TWIML: WebhookAcknowledgement = {
  status: 200,
  contentType: 'text/xml',
  body: '<?xml version="1.0" encoding="UTF-8"?><Response/>',
};

const NO_MEDIA: OutboundMediaResolver = {
  signedUrl: () => Promise.reject(new Error('no media resolver supplied')),
  read: () => Promise.reject(new Error('no media resolver supplied')),
};

export class TwilioWhatsAppChannelAdapter implements ChannelAdapter {
  readonly kind = 'TWILIO_WHATSAPP' as const;

  constructor(private readonly deps: ChannelAdapterDeps) {}

  capabilities(_config?: ChannelRuntimeConfig): ChannelCapabilities {
    return TWILIO_WHATSAPP_CAPABILITIES;
  }

  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateTwilioWhatsAppConfig(settings, secrets);
  }

  describe(): ChannelKindDescriptor {
    return TWILIO_WHATSAPP_DESCRIPTOR;
  }

  /** Only the auth token is needed, so a settings problem never blocks signature checks. */
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
    return verifyTwilioSignature(req, config.secrets['authToken']);
  }

  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    const { settings } = resolveTwilioConfig(config);
    return parseTwilioWebhook(req.rawBody, { accountSid: settings.accountSid, now: this.deps.now });
  }

  webhookAcknowledgement(): WebhookAcknowledgement {
    return EMPTY_TWIML;
  }

  fetchMedia(ref: MediaRef, config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    return fetchTwilioMedia(ref, { config: resolveTwilioConfig(config), fetch: this.deps.fetch, capabilities: this.capabilities(config) });
  }

  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[] {
    return renderTwilioParts(parts, this.capabilities(config));
  }

  async send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return resolved;
    return sendTwilioMessage(target, message, {
      config: resolved,
      client: new TwilioRestClient(resolved, this.deps.fetch),
      capabilities: this.capabilities(config),
      media,
      now: this.deps.now(),
    });
  }

  /** Build a Content Template payload (for outbox storage) without sending it. */
  renderTemplate(template: TwilioTemplateInput): RenderedOutbound {
    return renderTwilioTemplate(template);
  }

  /** Send an approved template chosen from listTemplates (Content SID + ContentVariables); allowed outside the 24-hour window. */
  sendTemplate(target: OutboundTarget, request: TemplateSendRequest, config: ChannelRuntimeConfig): Promise<SendResult> {
    return this.sendContentTemplate(target, { contentSid: request.templateId, variables: request.variables }, config);
  }

  /** Content templates with their WhatsApp approval (Content API, same credentials). */
  async listTemplates(config: ChannelRuntimeConfig): Promise<MessageTemplate[]> {
    return this.templates(config).list();
  }

  /** Create the content and submit it for WhatsApp approval. */
  async createTemplate(config: ChannelRuntimeConfig, draft: TemplateDraft): Promise<MessageTemplate> {
    return this.templates(config).create(draft);
  }

  async templateStatus(config: ChannelRuntimeConfig, templateId: string): Promise<MessageTemplate | null> {
    return this.templates(config).status(templateId);
  }

  async deleteTemplate(config: ChannelRuntimeConfig, template: { id: string; name: string }): Promise<void> {
    await this.templates(config).remove(template.id);
  }

  /** Send a Content Template by ContentSid (+ variables); allowed outside the 24-hour window. */
  async sendContentTemplate(target: OutboundTarget, template: TwilioTemplateInput, config: ChannelRuntimeConfig): Promise<SendResult> {
    let rendered: RenderedOutbound;
    try {
      rendered = renderTwilioTemplate(template);
    } catch (error) {
      return sendFailure('invalid_template', isDomainError(error) ? error.message : 'invalid Twilio content template');
    }
    return this.send(target, rendered, config, NO_MEDIA);
  }

  async checkConnection(config: ChannelRuntimeConfig): Promise<ConnectionCheckResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return { ok: false, checks: [{ name: 'Configuration', ok: false, detail: resolved.message }] };
    return checkTwilioConnection(resolved, this.deps.fetch);
  }

  private templates(config: ChannelRuntimeConfig): TwilioTemplates {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) throw new TemplateProviderError('not_configured', resolved.message);
    return new TwilioTemplates(resolved, this.deps.fetch);
  }

  private tryResolve(config: ChannelRuntimeConfig): ResolvedTwilioConfig | SendFailure {
    try {
      return resolveTwilioConfig(config);
    } catch (error) {
      return sendFailure('invalid_channel_config', isDomainError(error) ? error.message : 'invalid channel configuration');
    }
  }
}

export function createTwilioWhatsAppAdapter(deps: Partial<ChannelAdapterDeps> = {}): TwilioWhatsAppChannelAdapter {
  return new TwilioWhatsAppChannelAdapter({
    fetch: deps.fetch ?? globalThis.fetch.bind(globalThis),
    now: deps.now ?? (() => new Date()),
  });
}
