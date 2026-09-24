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
import { ChannelMediaError, invalidInbound } from '../common/errors.js';
import { TEAMS_CAPABILITIES } from './capabilities.js';
import { resolveTeamsConfig, resolveTeamsSettings, validateTeamsConfig, type ResolvedTeamsConfig } from './config.js';
import { checkTeamsConnection } from './connection-check.js';
import { BotConnectorClient, realSleep, type Sleep } from './connector.js';
import { TEAMS_DESCRIPTOR } from './descriptor.js';
import { sendFailure, type SendFailure } from './errors.js';
import { displayTeamsIdentity } from './identity.js';
import { parseTeamsActivity } from './inbound.js';
import { PersonalChats } from './personal-chats.js';
import { fromReplyContext } from './reply-context.js';
import { renderTeamsParts, TEAMS_KIND } from './render.js';
import { sendTeamsMessage } from './send.js';
import { BotFrameworkKeyStore } from './signing-keys.js';
import { TeamsTokenClient } from './token-client.js';
import { verifyTeamsRequest } from './verification.js';

/**
 * Microsoft Teams channel (Azure Bot Service / Bot Framework: activities in,
 * Bot Connector REST out). Transport only: it never persists, never runs the
 * agent loop and never logs. One instance serves every Teams channel; it
 * keeps process-wide caches: Microsoft's signing keys (bounded TTL) and
 * client-credentials tokens (until shortly before expiry), both fetched
 * through the guarded egress `deps.fetch`, and each person's personal chat
 * with the bot (bounded, a day), where a send with no reply context goes.
 */

/** The Bot Connector wants a quick empty 200; replies go out through the connector API. */
const EMPTY_OK: WebhookAcknowledgement = { status: 200, contentType: 'text/plain', body: '' };

export interface MsTeamsAdapterDeps extends ChannelAdapterDeps {
  /** Waits between 429/5xx retries (tests pass a no-op). */
  sleep: Sleep;
}

export class MsTeamsChannelAdapter implements ChannelAdapter {
  readonly kind = TEAMS_KIND;
  private readonly keys: BotFrameworkKeyStore;
  private readonly tokens: TeamsTokenClient;
  private readonly personal: PersonalChats;

  constructor(private readonly deps: MsTeamsAdapterDeps) {
    const clock = () => deps.now().getTime();
    this.keys = new BotFrameworkKeyStore(deps.fetch, clock);
    this.tokens = new TeamsTokenClient(deps.fetch, clock);
    this.personal = new PersonalChats(clock);
  }

  capabilities(_config?: ChannelRuntimeConfig): ChannelCapabilities {
    return TEAMS_CAPABILITIES;
  }

  describe(): ChannelKindDescriptor {
    return TEAMS_DESCRIPTOR;
  }

  displayIdentity(identityKind: string, value: string): string | null {
    return displayTeamsIdentity(identityKind, value);
  }

  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    return validateTeamsConfig(settings, secrets);
  }

  /** The Bot Connector's JWT against Microsoft's published keys (async: the keys are fetched and cached). */
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): Promise<VerificationResult> {
    return verifyTeamsRequest(req, config, { keys: this.keys, now: this.deps.now });
  }

  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope {
    const resolved = resolveTeamsSettings(config);
    if (!resolved) throw invalidInbound('teams_invalid_config', 'channel settings are not valid');
    const envelope = parseTeamsActivity(req.rawBody, { settings: resolved.settings, now: this.deps.now });
    for (const message of envelope.messages) {
      const context = fromReplyContext(message.replyContext);
      if (context) this.personal.remember(config.id, message.identityValue, context);
    }
    return envelope;
  }

  webhookAcknowledgement(): WebhookAcknowledgement {
    return EMPTY_OK;
  }

  /** v1 imports no Teams files: inbound parts are text and card taps only. */
  fetchMedia(_ref: MediaRef, _config: ChannelRuntimeConfig): Promise<FetchedMedia> {
    return Promise.reject(new ChannelMediaError('not_applicable', 'the Microsoft Teams channel does not import files'));
  }

  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[] {
    return renderTeamsParts(parts, this.capabilities(config));
  }

  async send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, _media: OutboundMediaResolver): Promise<SendResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return resolved;
    return sendTeamsMessage(target, message, {
      config: resolved,
      connector: new BotConnectorClient(resolved, this.tokens, this.deps.fetch, this.deps.sleep),
      personalChat: (identityValue) => this.personal.find(config.id, identityValue),
    });
  }

  async checkConnection(config: ChannelRuntimeConfig): Promise<ConnectionCheckResult> {
    const resolved = this.tryResolve(config);
    if ('ok' in resolved) return { ok: false, checks: [{ name: 'Configuration', ok: false, detail: resolved.message }] };
    return checkTeamsConnection(resolved, this.tokens, this.keys);
  }

  private tryResolve(config: ChannelRuntimeConfig): ResolvedTeamsConfig | SendFailure {
    try {
      return resolveTeamsConfig(config);
    } catch (error) {
      return sendFailure('invalid_channel_config', isDomainError(error) ? error.message : 'invalid channel configuration');
    }
  }
}

/** `deps.fetch` is the composition root's guarded egress fetch (or a test stub); without it the adapter has no network. */
export function createMsTeamsAdapter(deps: Partial<MsTeamsAdapterDeps> = {}): MsTeamsChannelAdapter {
  return new MsTeamsChannelAdapter({
    fetch: deps.fetch ?? NO_NETWORK,
    now: deps.now ?? (() => new Date()),
    sleep: deps.sleep ?? realSleep,
  });
}
