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
 * A ready-made file the admin pastes or uploads into the provider's console after saving (a Slack app
 * manifest, a Teams app manifest). The web app fills the placeholders from the saved channel and offers copy
 * and download. Only `{{webhookUrl}}` and `{{settings.<key>}}` exist: secrets are never interpolated.
 * Values are inserted as plain text: JSON-string-escaped for `application/json` (put placeholders inside
 * string literals), and for YAML and plain text any value with quotes, backslashes, `#`, control characters
 * or line breaks is left out (the placeholder stays and the admin is told to fill it in).
 */
export interface ChannelSetupFile {
  /** Stable id within the kind (`a-z0-9-`). */
  key: string;
  /** Heading shown above the file ("Teams app manifest"). */
  label: string;
  /** What to do with it, one sentence. */
  description?: string | undefined;
  /** Download name, e.g. `manifest.json`. */
  filename: string;
  contentType: 'application/json' | 'text/yaml' | 'text/plain';
  template: string;
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
  /** Files to paste or upload in the provider's console (app manifests), shown with the setup steps. */
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
  /** The adapter offers a read-only credential check (`POST /v1/channels/:id/test`). */
  connectionCheck: boolean;
  /** Customers may be reached with provider-approved message templates. */
  messageTemplates: boolean;
}

/** `{{webhookUrl}}` or `{{settings.<key>}}`: the only placeholders a setup file may use. */
export const SETUP_FILE_PLACEHOLDER = /\{\{\s*(webhookUrl|settings\.[A-Za-z][A-Za-z0-9_]{0,63})\s*\}\}/g;
const ANY_PLACEHOLDER = /\{\{([^}]*)\}\}/g;
const SETUP_FILE_KEY = /^[a-z][a-z0-9-]{0,39}$/;
const SETUP_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SETUP_FILE_TYPES: ReadonlySet<string> = new Set(['application/json', 'text/yaml', 'text/plain']);
const MAX_SETUP_FILE_BYTES = 64 * 1024;

/** Problems with a kind's setup files (registration refuses the kind when there are any). */
export function setupFileProblems(files: readonly ChannelSetupFile[] | undefined): string[] {
  if (files === undefined) return [];
  if (!Array.isArray(files)) return ['setupFiles must be an array'];
  const problems: string[] = [];
  const keys = new Set<string>();
  files.forEach((file, i) => {
    const at = `setupFiles[${i}]`;
    if (typeof file?.key !== 'string' || !SETUP_FILE_KEY.test(file.key)) problems.push(`${at}: invalid key "${String(file?.key)}"`);
    else if (keys.has(file.key)) problems.push(`${at}: duplicate key "${file.key}"`);
    else keys.add(file.key);
    if (typeof file?.label !== 'string' || !file.label.trim()) problems.push(`${at}: label is required`);
    if (typeof file?.filename !== 'string' || !SETUP_FILE_NAME.test(file.filename)) problems.push(`${at}: invalid filename "${String(file?.filename)}"`);
    if (!SETUP_FILE_TYPES.has(file?.contentType)) problems.push(`${at}: contentType must be application/json, text/yaml or text/plain`);
    if (typeof file?.template !== 'string' || !file.template.length) return void problems.push(`${at}: template is required`);
    if (new TextEncoder().encode(file.template).byteLength > MAX_SETUP_FILE_BYTES) problems.push(`${at}: template exceeds 64 KiB`);
    for (const match of file.template.matchAll(ANY_PLACEHOLDER)) {
      const token = match[0];
      if (!new RegExp(`^${SETUP_FILE_PLACEHOLDER.source}$`).test(token)) problems.push(`${at}: unknown placeholder ${token} (only {{webhookUrl}} and {{settings.<key>}}; secrets are never interpolated)`);
    }
  });
  return problems;
}
