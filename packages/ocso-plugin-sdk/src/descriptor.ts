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
 * are. OCSO builds the zip on the server.
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
  /** Name of the integration in admin screens. */
  label: string;
  description: string;
  mark: ChannelMark;
  /** JSON Schema (input shape) of the non-secret settings. */
  settingsSchema: Record<string, unknown>;
  secrets: ChannelSecretField[];
  identitySetting?: ChannelIdentitySetting | undefined;
  /** Deprecated: plain sentences, in order. Use `setupGuide`; OCSO turns these into one guide step each. */
  setupSteps?: readonly string[] | undefined;
  /**
   * The step-by-step guide the channel dialog shows as a checklist (provider console, OCSO's form, first test).
   * Plain text; https links only; values may use the setup-file placeholders; at most one `form` step.
   */
  setupGuide?: readonly ChannelSetupStep[] | undefined;
  /** Known problems and their fixes; a connection check points to one with `ConnectionCheck.help`. */
  troubleshooting?: readonly ChannelTroubleshooting[] | undefined;
  /** Files to paste or upload in the provider's console (app manifests, app packages), offered in the guide. */
  setupFiles?: readonly ChannelSetupFile[] | undefined;
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
  /**
   * Staff can use this kind to talk to Ask OCSO (a workplace chat such as Slack or Teams). OCSO then adds its own
   * `destination` setting (`router` | `ask_ocso`) to the kind's settings form and routes `ask_ocso` channels'
   * messages to Ask OCSO as the staff member who linked their chat account. Do not declare `destination` in
   * `settingsSchema` yourself.
   */
  staffDestination?: boolean | undefined;
  /** How Ask OCSO threads and audit rows name this kind (`teams`: `a-z0-9_`, up to 32); defaults to the kind in lower case. */
  staffSurface?: string | undefined;
}
