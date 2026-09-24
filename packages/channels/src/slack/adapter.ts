import type { InteractionPart, MediaRef } from '@ocso/domain';
import { isDomainError } from '@ocso/domain';
import type {
  ChannelAdapter,
  ChannelAdapterDeps,
  ChannelCapabilities,
  ChannelRuntimeConfig,
  ConnectionCheckResult,
  FetchedMedia,
  InboundEnvelope,
  OutboundMediaResolver,
  OutboundTarget,
  RawHttpRequest,
  RenderedOutbound,
  SendResult,
  VerificationResult,
  WebhookAcknowledgement,
} from '../contract/types.js';
import { NO_NETWORK } from '../contract/types.js';
import type { ChannelKindDescriptor } from '../contract/descriptor.js';
import { ChannelMediaError } from '../common/errors.js';
import { SLACK_CAPABILITIES } from './capabilities.js';
import { resolveSlackConfig, slackSettingsOf, validateSlackConfig, type ResolvedSlackConfig } from './config.js';
import { checkSlackConnection } from './connection-check.js';
import { SLACK_DESCRIPTOR } from './descriptor.js';
import { sendFailure, type SendFailure } from './errors.js';
import { displaySlackIdentity } from './identity.js';
import { slackJsonBody, urlVerificationChallenge } from './inbound/body.js';
import { parseSlackRequest } from './inbound/parse.js';
import { renderSlackParts } from './render.js';
import { sendSlackMessage } from './send.js';
import { verifySlackSignature } from './signature.js';
import { realSleep, SlackWebApi, type Sleep } from './web-api.js';

/**
 * Slack app channel (Events API + interactivity in, Web API out). Transport
 * only: it never persists, never runs the agent loop and never logs. One
 * instance serves every Slack channel; per-channel settings and secrets
 * arrive with each call.
 */

/** Slack wants a quick empty 200; replies go out through `chat.postMessage`. */
const EMPTY_OK: WebhookAcknowledgement = { status: 200, contentType: 'text/plain', body: '' };

export interface SlackAdapterDeps extends ChannelAdapterDeps {
  /** Waits between 429 retries (tests pass a no-op). */
  sleep: Sleep;
}

export class SlackChannelAdapter implements ChannelAdapter {
  readonly kind = 'SLACK' as const;

  constructor(private readonly deps: SlackAdapterDeps) {}

  capabilities(_config?: ChannelRuntimeConfig): ChannelCapabilities {
    return SLACK_CAPABILITIES;
  }

  describe(): ChannelKindDescriptor {
    return SLACK_DESCRIPTOR;
  }

  displayIdentity(identityKind: string, value: string): string | null {
    return displaySlackIdentity(identityKind, value);
  }

  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateSlackConfig(settings, secrets);
  }

  /**
   * The signature first (only the signing secret is needed, so a settings problem never blocks it); then a
   * signed `url_verification` is answered with its challenge and nothing is stored.
   */
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult {
    const signed = verifySlackSignature(req, config.secrets['signingSecret'], this.deps.now());
    if (signed.kind !== 'verified') return signed;
    const challenge = urlVerificationChallenge(slackJsonBody(req.rawBody));
    if (challenge === undefined) return signed;
    if (challenge === null) return { kind: 'rejected', status: 400, reason: 'malformed url_verification challenge' };
    return { kind: 'challenge', status: 200, body: challenge };
  }

  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    return parseSlackRequest(req.rawBody, { settings: slackSettingsOf(config), now: this.deps.now });
  }

  webhookAcknowledgement(): WebhookAcknowledgement {
    return EMPTY_OK;
  }

  /** v1 imports no Slack files: inbound parts are text and button replies only. */
  fetchMedia(_ref: MediaRef, _config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    return Promise.reject(new ChannelMediaError('not_applicable', 'the Slack channel does not import files'));
  }

  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[] {
    return renderSlackParts(parts, this.capabilities(config));
  }

  async send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, _media: OutboundMediaResolver): Promise<SendResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return resolved;
    return sendSlackMessage(target, message, { config: resolved, api: new SlackWebApi(resolved, this.deps.fetch, this.deps.sleep) });
  }

  async checkConnection(config: ChannelRuntimeConfig): Promise<ConnectionCheckResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return { ok: false, checks: [{ name: 'Configuration', ok: false, detail: resolved.message }] };
    return checkSlackConnection(resolved, this.deps.fetch, this.deps.sleep);
  }

  private tryResolve(config: ChannelRuntimeConfig): ResolvedSlackConfig | SendFailure {
    try {
      return resolveSlackConfig(config);
    } catch (error) {
      return sendFailure('invalid_channel_config', isDomainError(error) ? error.message : 'invalid channel configuration');
    }
  }
}

/** `deps.fetch` is the composition root's guarded egress fetch (or a test stub); without it the adapter has no network. */
export function createSlackChannelAdapter(deps: Partial<SlackAdapterDeps> = {}): SlackChannelAdapter {
  return new SlackChannelAdapter({
    fetch: deps.fetch ?? NO_NETWORK,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? realSleep,
  });
}
