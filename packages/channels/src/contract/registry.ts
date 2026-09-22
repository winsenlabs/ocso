import type { ChannelAdapter, ChannelKind } from './types.js';

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `TWILIO_WHATSAPP` -> `twilio-whatsapp`: the default webhook URL segment of a kind. */
export function defaultWebhookSegment(kind: string): string {
  return kind.toLowerCase().replace(/_/g, '-');
}

/**
 * Channel adapters are registered, never switched on (build rule §4). The
 * registry is the one place that knows which kinds exist in a deployment and
 * where each kind's public endpoints live.
 */
export class ChannelRegistry {
  private readonly adapters = new Map<ChannelKind, ChannelAdapter>();
  private readonly segments = new Map<string, ChannelKind>();

  register(adapter: ChannelAdapter): this {
    if (this.adapters.has(adapter.kind)) throw new Error(`channel adapter ${adapter.kind} already registered`);
    const descriptor = adapter.describe?.();
    if (descriptor?.inboundWebhook) {
      const segment = descriptor.webhookSegment ?? defaultWebhookSegment(adapter.kind);
      if (!SEGMENT.test(segment)) throw new Error(`invalid webhook segment "${segment}" for ${adapter.kind}`);
      if (this.segments.has(segment)) throw new Error(`webhook segment "${segment}" already registered`);
      this.segments.set(segment, adapter.kind);
    }
    this.adapters.set(adapter.kind, adapter);
    return this;
  }

  get(kind: ChannelKind): ChannelAdapter {
    const adapter = this.adapters.get(kind);
    if (!adapter) throw new Error(`no channel adapter registered for ${kind}`);
    return adapter;
  }

  /** True when an adapter for this kind is registered (narrows arbitrary input). */
  has(kind: string): kind is ChannelKind {
    return this.adapters.has(kind as ChannelKind);
  }

  kinds(): ChannelKind[] {
    return [...this.adapters.keys()];
  }

  /** The kind whose inbound webhook lives at `/channels/<segment>/…`, if any. */
  kindForWebhookSegment(segment: string): ChannelKind | null {
    return this.segments.get(segment) ?? null;
  }

  /**
   * Public path of a channel instance: the provider webhook for inbound-webhook
   * kinds, the widget page for embeddable kinds, otherwise null.
   */
  publicPath(kind: string, publicKey: string): string | null {
    if (!this.has(kind)) return null;
    const descriptor = this.get(kind).describe?.();
    if (descriptor?.inboundWebhook) {
      const segment = descriptor.webhookSegment ?? defaultWebhookSegment(kind);
      return `/channels/${segment}/${encodeURIComponent(publicKey)}/webhook`;
    }
    return descriptor?.embeddable ? `/webchat/${encodeURIComponent(publicKey)}` : null;
  }

  /** Absolute inbound webhook URL on the public origin (null for kinds without one). */
  webhookUrl(kind: string, publicKey: string, publicUrl: string): string | null {
    const path = this.publicPath(kind, publicKey);
    if (!path?.startsWith('/channels/') || !URL.canParse(publicUrl)) return null;
    return `${new URL(publicUrl).origin}${path}`;
  }
}
