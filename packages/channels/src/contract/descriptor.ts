/**
 * What a channel kind tells the rest of OCSO about itself (docs/plugins/channels.md).
 * Everything the API and the web app know about a kind — form, labels, marks,
 * setup steps, public paths, template wording — comes from here, served by
 * `GET /v1/channels/kinds`. Core code never switches on a kind.
 */

/**
 * A channel kind names an adapter (`WHATSAPP`, `TWILIO_WHATSAPP`, …). Kinds
 * are open: a kind exists when its adapter is registered, and the registry is
 * the only authority (the DB column is text; nothing enumerates kinds).
 */
export type ChannelKind = string;

/** Shape of a kind: upper snake case, 2–40 characters. */
export const CHANNEL_KIND_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;

/** A secret the admin enters (or OCSO generates) when configuring a channel; never returned by the API. */
export interface ChannelSecretField {
  key: string;
  label: string;
  required: boolean;
  hint: string;
  /** `server`: OCSO generates it when omitted (nobody needs to see it). `client`: the form may offer a generator, since the admin must copy it elsewhere. */
  generate?: 'server' | 'client' | undefined;
}

/**
 * The badge conversations of this kind carry in the UI. It names the network
 * the customer uses, not the provider: WhatsApp through Twilio and through
 * Meta share one mark.
 */
export interface ChannelMark {
  /** Two-character badge text, e.g. `WA`. */
  code: string;
  /** The network as customers and staff call it ("WhatsApp"); the workspace shows it. */
  name: string;
  /** Design-system tone of the badge (`wa`, `vo`, `ig`); omitted = neutral. */
  tone?: string | undefined;
}

/** A non-secret setting that identifies one channel of this kind in lists (e.g. the WhatsApp sender). */
export interface ChannelIdentitySetting {
  label: string;
  /** Settings keys in order of preference; the first holding a string is shown. */
  keys: readonly string[];
}

/** How a kind's message templates behave in the builder and in copy (kinds whose adapter implements the template methods). */
export interface ChannelTemplateTerms {
  /** Who reviews templates, as in "submitted for WhatsApp approval". */
  reviewer: string;
  /** Variables are numbered across the whole template (`1`) or per component (`body.1`); the builder previews with the same keys. */
  placeholderScope: 'template' | 'component';
  /** Why templates with a media header cannot be created from OCSO on this kind; omit when they can. */
  mediaHeaderUnsupported?: string | undefined;
}

/** What the "Add channel" form, the channel list and the workspace need to know about a kind. */
export interface ChannelKindDescriptor {
  kind: ChannelKind;
  /** Name of the integration in admin screens ("WhatsApp — Twilio"). */
  label: string;
  description: string;
  mark: ChannelMark;
  /** JSON Schema (input shape) of the non-secret settings. */
  settingsSchema: Record<string, unknown>;
  secrets: ChannelSecretField[];
  /** Shown on the channel card; omit when no setting identifies an instance. */
  identitySetting?: ChannelIdentitySetting | undefined;
  /** What the admin does in the provider's console after saving (plain sentences, in order). */
  setupSteps: readonly string[];
  /** Provider calls OCSO at `/channels/<webhookSegment>/<publicKey>/webhook`. */
  inboundWebhook: boolean;
  /** URL segment of the inbound webhook (lower-case, `a-z0-9-`); defaults to the kind in kebab case. */
  webhookSegment?: string | undefined;
  /** What the provider posts to that webhook, for the Webhooks list ("messages, delivery statuses"). */
  webhookEvents?: string | undefined;
  /**
   * Customers reach it through OCSO's embeddable widget: the script
   * `/ocso-webchat.js` (`data-key=<publicKey>`), the page `/chat/<publicKey>`
   * and the public API `/public/webchat/<publicKey>/*`. Requires the adapter's
   * `embed` hooks.
   */
  embeddable: boolean;
  /** Present when the adapter implements the message-template methods. */
  templates?: ChannelTemplateTerms | undefined;
}

/** A descriptor plus what the registry derives from the adapter (served by `GET /v1/channels/kinds`). */
export interface ChannelKindInfo extends ChannelKindDescriptor {
  /** The adapter offers a read-only credential check (`POST /v1/channels/:id/test`). */
  connectionCheck: boolean;
  /** Customers may be reached with provider-approved message templates. */
  messageTemplates: boolean;
}
