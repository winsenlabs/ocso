import type { ChannelKind } from './channels.js';

/**
 * What a channel kind tells OCSO about itself, served by `GET /v1/channels/kinds`
 * and rendered by generic forms: a plugin cannot ship web UI, so everything
 * the admin sees (form, labels, badge, setup steps, template wording) is data.
 */


/** A secret the admin enters (or OCSO generates) when configuring a channel; never returned by the API. */
export interface ChannelSecretField {
  key: string;
  label: string;
  required: boolean;
  hint: string;
  /** `server`: OCSO generates it when omitted. `client`: the form offers a generator (the admin copies it elsewhere). */
  generate?: 'server' | 'client' | undefined;
  /** Prefix of generated values (e.g. `sk_`), so keys are recognisable wherever they are pasted. */
  prefix?: string | undefined;
  /** `once`: a server-generated value is shown once at creation, and the edit form offers a rotate action. */
  reveal?: 'once' | undefined;
}

/** The badge conversations of this kind carry in the UI. */
export interface ChannelMark {
  /** 1–3 letters or digits, e.g. `LN`. */
  code: string;
  /** The network as customers and staff call it ("LINE"). */
  name: string;
  /** Design-system tone of the badge; omitted = neutral. */
  tone?: string | undefined;
}

/** A non-secret setting that identifies one channel of this kind in lists. */
export interface ChannelIdentitySetting {
  label: string;
  /** Settings keys in order of preference; the first holding a string is shown. */
  keys: readonly string[];
}

/** How a kind's message templates behave in the builder and in copy. */
export interface ChannelTemplateTerms {
  /** Who reviews templates, as in "submitted for WhatsApp approval". */
  reviewer: string;
  placeholderScope: 'template' | 'component';
  /** Why templates with a media header cannot be created from OCSO on this kind; omit when they can. */
  mediaHeaderUnsupported?: string | undefined;
}

/** What the "Add channel" form, the channel list and the workspace need to know about a kind. */
export interface ChannelKindDescriptor {
  kind: ChannelKind;
  /** Name of the integration in admin screens. */
  label: string;
  description: string;
  mark: ChannelMark;
  /** JSON Schema (input shape) of the non-secret settings. */
  settingsSchema: Record<string, unknown>;
  secrets: ChannelSecretField[];
  identitySetting?: ChannelIdentitySetting | undefined;
  /** What the admin does in the provider's console after saving (plain sentences, in order). */
  setupSteps: readonly string[];
  /** Provider calls OCSO at `/channels/<webhookSegment>/<publicKey>/webhook`. */
  inboundWebhook: boolean;
  /** URL segment of the inbound webhook (`a-z0-9-`); defaults to the kind in kebab case. */
  webhookSegment?: string | undefined;
  /** What the provider posts to that webhook, for the Webhooks list. */
  webhookEvents?: string | undefined;
  /** Customers reach it through OCSO's embeddable widget and public web chat API; requires `embed`. */
  embeddable: boolean;
  /** Present exactly when the adapter implements the message-template methods. */
  templates?: ChannelTemplateTerms | undefined;
}
