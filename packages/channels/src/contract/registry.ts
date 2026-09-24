import {
  CHANNEL_DESTINATIONS,
  CHANNEL_KIND_PATTERN,
  DESTINATION_SETTING,
  setupFileProblems,
  type ChannelDestination,
  type ChannelKind,
  type ChannelKindDescriptor,
  type ChannelKindInfo,
} from './descriptor.js';
import type { EmbeddedChat } from './embed.js';
import type { ChannelAdapter } from './types.js';

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MARK_CODE = /^[A-Za-z0-9]{1,3}$/;
const STAFF_SURFACE = /^[a-z][a-z0-9_]{0,31}$/;

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
    const fileProblems = setupFileProblems(descriptor.setupFiles);
    if (fileProblems.length) throw new Error(`channel adapter ${kind}: ${fileProblems.join('; ')}`);
    if (descriptor.staffDestination !== undefined && typeof descriptor.staffDestination !== 'boolean') throw new Error(`channel adapter ${kind}: staffDestination must be a boolean`);
    if (descriptor.staffSurface !== undefined && (typeof descriptor.staffSurface !== 'string' || !STAFF_SURFACE.test(descriptor.staffSurface))) {
      throw new Error(`channel adapter ${kind}: staffSurface must be lower-case a-z0-9_ (up to 32 characters)`);
    }
    if (descriptor.staffDestination && schemaProperties(descriptor.settingsSchema)?.[DESTINATION_SETTING] !== undefined) {
      throw new Error(`channel adapter ${kind}: the "${DESTINATION_SETTING}" setting belongs to OCSO on staff-destination kinds; remove it from the settings schema`);
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

  /**
   * The kind's descriptor plus what the registry derives from its adapter (for `GET /v1/channels/kinds`). A
   * staff-destination kind's settings schema gains OCSO's own `destination` setting, so the admin form offers it.
   */
  describe(kind: ChannelKind): ChannelKindInfo {
    const adapter = this.get(kind);
    const descriptor = adapter.describe();
    const settingsSchema = descriptor.staffDestination ? withDestinationSetting(descriptor.settingsSchema) : descriptor.settingsSchema;
    return { ...descriptor, settingsSchema, connectionCheck: typeof adapter.checkConnection === 'function', messageTemplates: supportsTemplates(adapter) };
  }

  /**
   * Where a channel's inbound messages go: `ask_ocso` only for a staff-destination kind whose settings say so,
   * `router` otherwise (every other kind, unknown kinds, and a missing or unknown value).
   */
  destination(kind: string, settings: Readonly<Record<string, unknown>> | null | undefined): ChannelDestination {
    if (!this.has(kind) || !this.get(kind).describe().staffDestination) return 'router';
    return settings?.[DESTINATION_SETTING] === 'ask_ocso' ? 'ask_ocso' : 'router';
  }

  /** How Ask OCSO threads and audit rows name a staff chat kind (`slack`, `teams`): the descriptor's staffSurface, else the kind in lower case. */
  staffSurface(kind: string): string {
    const declared = this.has(kind) ? this.get(kind).describe().staffSurface : undefined;
    return declared ?? kind.toLowerCase();
  }

  /**
   * A channel configuration's problems: OCSO's `destination` setting (staff-destination kinds only), then the
   * adapter's own validation of the rest.
   */
  validateConfig(kind: string, settings: unknown, secrets: Readonly<Record<string, string>>): string[] {
    if (!this.has(kind)) return [`channel kind ${kind} is not available`];
    const adapter = this.get(kind);
    const staff = Boolean(adapter.describe().staffDestination);
    const record = settings && typeof settings === 'object' && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
    const problems: string[] = [];
    let own = settings;
    if (staff && record && DESTINATION_SETTING in record) {
      const { [DESTINATION_SETTING]: destination, ...rest } = record;
      if (destination !== undefined && !CHANNEL_DESTINATIONS.includes(destination as ChannelDestination)) {
        problems.push(`settings.${DESTINATION_SETTING}: must be one of ${CHANNEL_DESTINATIONS.join(', ')}`);
      }
      own = rest;
    }
    return [...problems, ...adapter.validateConfig(own, secrets)];
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

function schemaProperties(schema: Record<string, unknown>): Record<string, unknown> | null {
  const properties = schema['properties'];
  return properties && typeof properties === 'object' ? (properties as Record<string, unknown>) : null;
}

/** The `destination` setting OCSO adds to staff-destination kinds (JSON Schema, input shape). */
const DESTINATION_SCHEMA = {
  type: 'string',
  enum: [...CHANNEL_DESTINATIONS],
  default: 'router',
  title: 'Destination',
  description:
    'router: people who message this channel are customers, routed like any channel. ask_ocso: your staff talk to Ask OCSO here, as themselves, after linking their chat account to their OCSO user once.',
};

function withDestinationSetting(schema: Record<string, unknown>): Record<string, unknown> {
  return { ...schema, properties: { [DESTINATION_SETTING]: DESTINATION_SCHEMA, ...(schemaProperties(schema) ?? {}) } };
}

function supportsTemplates(adapter: ChannelAdapter): boolean {
  return typeof adapter.listTemplates === 'function' && typeof adapter.createTemplate === 'function' && typeof adapter.sendTemplate === 'function';
}
