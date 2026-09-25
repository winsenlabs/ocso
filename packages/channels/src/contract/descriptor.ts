/**
 * What a channel kind tells the rest of OCSO about itself (docs/guides/channels/README.md).
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
  /** Prefix of generated values (e.g. `sk_`), so keys are recognisable wherever they are pasted. */
  prefix?: string | undefined;
  /**
   * `once`: the admin needs the value elsewhere (e.g. a backend key): a server-generated value is returned once
   * in the create response, and the edit form offers a rotate action that generates a new one client-side.
   */
  reveal?: 'once' | undefined;
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

/**
 * A ready-made file the admin pastes or uploads into the provider's console (a Slack app manifest, a Teams app
 * package). OCSO fills the placeholders from the channel and offers copy and download. Only `{{webhookUrl}}`,
 * `{{webhookHost}}` (the webhook URL's host) and `{{settings.<key>}}` exist: secrets are never interpolated.
 * Values are inserted as plain text: JSON-string-escaped for `application/json` (put placeholders inside
 * string literals), and for YAML and plain text any value with quotes, backslashes, `#`, control characters
 * or line breaks is left out (the placeholder stays and the admin is told to fill it in).
 *
 * A text file carries a `template`. An `application/zip` file (an app package) carries `entries` instead: text
 * entries are templates filled the same way, binary entries (`image/png` icons) are base64 and copied as they
 * are. OCSO builds the zip on the server (`GET /v1/channels/:id/setup-files/:key`).
 */
export interface ChannelSetupFile {
  /** Stable id within the kind (`a-z0-9-`). */
  key: string;
  /** Heading shown above the file ("Teams app package"). */
  label: string;
  /** What to do with it, one sentence. */
  description?: string | undefined;
  /** Download name, e.g. `manifest.json`. */
  filename: string;
  contentType: ChannelSetupFileType;
  /** Text files: the content with placeholders. */
  template?: string | undefined;
  /** `application/zip` only: the files inside the package. */
  entries?: readonly ChannelSetupFileEntry[] | undefined;
}

export type ChannelSetupFileType = 'application/json' | 'text/yaml' | 'text/plain' | 'application/zip';

/** One file inside an `application/zip` setup file. */
export interface ChannelSetupFileEntry {
  /** Path inside the zip (`manifest.json`, `color.png`); no folders above the root. */
  path: string;
  contentType: 'application/json' | 'text/yaml' | 'text/plain' | 'image/png';
  /** Text entries: the content with placeholders. */
  template?: string | undefined;
  /** `image/png` entries: the bytes, base64. */
  base64?: string | undefined;
}

/**
 * One step of the setup guide the channel dialog shows as a numbered checklist (in order). Plain text only: the
 * web app renders no markup from a descriptor. `values` are shown with a Copy button and may use the setup-file
 * placeholders (`{{webhookUrl}}`, …); `files` names setup files (by key) to offer inside this step; `form` marks
 * the step where the admin fills OCSO's own form (settings and secrets), which the dialog shows there.
 */
export interface ChannelSetupStep {
  title: string;
  body: string;
  /** Bullet points under the body. */
  items?: readonly string[] | undefined;
  /** A small two-column table (e.g. each scope and why it is needed). */
  table?: { head: readonly [string, string]; rows: ReadonlyArray<readonly [string, string]> } | undefined;
  /** Values to copy into the provider's console (the webhook URL, a scope list). */
  values?: ReadonlyArray<{ label: string; value: string }> | undefined;
  /** Provider consoles and documentation (https only). */
  links?: ReadonlyArray<{ label: string; href: string }> | undefined;
  /** Keys of this kind's `setupFiles` to offer in this step. */
  files?: readonly string[] | undefined;
  /** The admin fills OCSO's settings and secrets in this step (at most one step). */
  form?: boolean | undefined;
  /** How to tell the step worked. */
  check?: string | undefined;
}

/** A known problem and its fix. `id` lets a connection check point to it (`ConnectionCheck.help`). */
export interface ChannelTroubleshooting {
  id: string;
  problem: string;
  fix: string;
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
  /**
   * Deprecated: plain sentences, in order. Use `setupGuide`; a kind that only has `setupSteps` gets a guide with
   * one step per sentence (`GET /v1/channels/kinds` always serves `setupGuide`).
   */
  setupSteps?: readonly string[] | undefined;
  /** The step-by-step guide the channel dialog shows as a checklist: provider console, OCSO's form, first test. */
  setupGuide?: readonly ChannelSetupStep[] | undefined;
  /** Known problems and their fixes, shown under the guide; connection checks link to them by `id`. */
  troubleshooting?: readonly ChannelTroubleshooting[] | undefined;
  /** Files to paste or upload in the provider's console (app manifests, app packages), offered in the guide. */
  setupFiles?: readonly ChannelSetupFile[] | undefined;
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
  /**
   * Staff can use this kind to talk to Ask OCSO (a workplace chat such as Slack or Teams). Core then offers the
   * `destination` setting on its channels: `router` (default: customers, routed like any channel) or `ask_ocso`
   * (staff link their chat account to their OCSO user and ask Ask OCSO as themselves; no customer conversations).
   * The adapter needs nothing else: core adds the setting to the settings schema and reads it.
   */
  staffDestination?: boolean | undefined;
  /**
   * How Ask OCSO threads and audit rows name this kind when staff ask through it (`slack`, `teams`: lower-case
   * `a-z0-9_`, at most 32 characters). Defaults to the kind in lower case. Only read on staff-destination kinds.
   */
  staffSurface?: string | undefined;
}

/** Where a channel's inbound messages go (`settings.destination`, for kinds whose descriptor sets `staffDestination`). */
export type ChannelDestination = 'router' | 'ask_ocso';
export const CHANNEL_DESTINATIONS: readonly ChannelDestination[] = ['router', 'ask_ocso'];
/** The settings key core owns on staff-destination kinds. */
export const DESTINATION_SETTING = 'destination';

/** A descriptor plus what the registry derives from the adapter (served by `GET /v1/channels/kinds`). */
export interface ChannelKindInfo extends ChannelKindDescriptor {
  /** Always present (derived from `setupSteps` for kinds that only have those). */
  setupGuide: readonly ChannelSetupStep[];
  troubleshooting: readonly ChannelTroubleshooting[];
  /** The adapter offers a read-only credential check (`POST /v1/channels/:id/test`). */
  connectionCheck: boolean;
  /** Customers may be reached with provider-approved message templates. */
  messageTemplates: boolean;
}
