import { CHANNEL_KIND_PATTERN, type ChannelKind, type ChannelKindDescriptor, type ChannelKindInfo } from './descriptor.js';
import type { EmbeddedChat } from './embed.js';
import type { ChannelAdapter } from './types.js';

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MARK_CODE = /^[A-Za-z0-9]{1,3}$/;

/** Path prefix of OCSO's widget page for embeddable kinds (`/chat/<publicKey>`, served by the web app). */
export const EMBED_PAGE_PREFIX = '/chat';

/** `TWILIO_WHATSAPP` -> `twilio-whatsapp`: the default webhook URL segment of a kind. */
export function defaultWebhookSegment(kind: string): string {
  return kind.toLowerCase().replace(/_/g, '-');
}

/**
 * Channel adapters are registered, never switched on (build rule §4). The
 * registry is the one place that knows which kinds exist in a deployment,
 * what each says about itself and where its public endpoints live. It
 * checks every adapter's descriptor once, at registration.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<ChannelKind, ChannelAdapter>();
  private readonly segments = new Map<string, ChannelKind>();

  register(adapter: ChannelAdapter): this {
    const kind = adapter.kind;
    if (!CHANNEL_KIND_PATTERN.test(kind)) throw new Error(`invalid channel kind "${kind}" (upper snake case, 2–40 characters)`);
    if (this.adapters.has(kind)) throw new Error(`channel adapter ${kind} already registered`);
    const descriptor = adapter.describe();
    if (descriptor.kind !== kind) throw new Error(`channel adapter ${kind} describes itself as ${descriptor.kind}`);
    if (!MARK_CODE.test(descriptor.mark.code)) throw new Error(`invalid mark code "${descriptor.mark.code}" for ${kind}`);
    if (descriptor.embeddable !== Boolean(adapter.embed)) throw new Error(`channel adapter ${kind}: embeddable kinds (and only they) implement the embed hooks`);
    if (Boolean(descriptor.templates) !== supportsTemplates(adapter)) {
      throw new Error(`channel adapter ${kind}: describe message templates exactly when the adapter implements listTemplates, createTemplate and sendTemplate`);
    }
    if (descriptor.inboundWebhook) {
      const segment = descriptor.webhookSegment ?? defaultWebhookSegment(kind);
      if (!SEGMENT.test(segment)) throw new Error(`invalid webhook segment "${segment}" for ${kind}`);
      if (this.segments.has(segment)) throw new Error(`webhook segment "${segment}" already registered`);
      this.segments.set(segment, kind);
    }
    this.adapters.set(kind, adapter);
    return this;
  }

  get(kind: ChannelKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no channel adapter registered for ${kind}`);
    return adapter;
  }

  /** True when an adapter for this kind is registered. */
  has(kind: string): boolean {
    return this.adapters.has(kind);
  }

  kinds(): ChannelKind[] {
    return [...this.adapters.keys()];
  }

  /** The kind's descriptor plus what the registry derives from its adapter (for `GET /v1/channels/kinds`). */
  describe(kind: ChannelKind): ChannelKindInfo {
    const adapter = this.get(kind);
    return { ...adapter.describe(), connectionCheck: typeof adapter.checkConnection === 'function', messageTemplates: supportsTemplates(adapter) };
  }

  /** Every registered kind, in registration order (the "Add channel" list order). */
  describeAll(): ChannelKindInfo[] {
    return this.kinds().map((kind) => this.describe(kind));
  }

  /** The kind whose inbound webhook lives at `/channels/<segment>/…`, if any. */
  kindForWebhookSegment(segment: string): ChannelKind | null {
    return this.segments.get(segment) ?? null;
  }

  /** The widget protocol of an embeddable kind; null for unknown or non-embeddable kinds. */
  embed(kind: string): EmbeddedChat | null {
    if (!this.has(kind)) return null;
    const adapter = this.get(kind);
    return adapter.describe().embeddable ? (adapter.embed ?? null) : null;
  }

  /** Provider webhook path of a channel instance (`/channels/<segment>/<publicKey>/webhook`), or null. */
  webhookPath(kind: string, publicKey: string): string | null {
    if (!this.has(kind)) return null;
    const descriptor = this.get(kind).describe();
    if (!descriptor.inboundWebhook) return null;
    const segment = descriptor.webhookSegment ?? defaultWebhookSegment(kind);
    return `/channels/${segment}/${encodeURIComponent(publicKey)}/webhook`;
  }

  /** Widget page of an embeddable channel instance (`/chat/<publicKey>`), or null. */
  embedPath(kind: string, publicKey: string): string | null {
    return this.embed(kind) ? `${EMBED_PAGE_PREFIX}/${encodeURIComponent(publicKey)}` : null;
  }

  /** Both public paths of a channel instance (channel views show them). */
  paths(kind: string, publicKey: string): { webhookPath: string | null; embedPath: string | null } {
    return { webhookPath: this.webhookPath(kind, publicKey), embedPath: this.embedPath(kind, publicKey) };
  }

  /** Where customers or the provider reach a channel instance: its webhook, else its widget page. */
  publicPath(kind: string, publicKey: string): string | null {
    return this.webhookPath(kind, publicKey) ?? this.embedPath(kind, publicKey);
  }

  /** Absolute inbound webhook URL on the public origin (null for kinds without one). */
  webhookUrl(kind: string, publicKey: string, publicUrl: string): string | null {
    const path = this.webhookPath(kind, publicKey);
    if (!path || !URL.canParse(publicUrl)) return null;
    return `${new URL(publicUrl).origin}${path}`;
  }

  /**
   * A customer identity as staff see it in lists, from the adapter that owns
   * the identity kind; null when no adapter claims it (callers mask generically).
   */
  displayIdentity(identityKind: string, value: string): string | null {
    for (const adapter of this.adapters.values()) {
      const shown = adapter.displayIdentity?.(identityKind, value);
      if (shown) return shown;
    }
    return null;
  }
}

function supportsTemplates(adapter: ChannelAdapter): boolean {
  return typeof adapter.listTemplates === 'function' && typeof adapter.createTemplate === 'function' && typeof adapter.sendTemplate === 'function';
}
