import type { DeliveryStatus, InteractionPart, InteractionPartType, MediaRef } from './domain.js';
import type { ChannelKindDescriptor } from './descriptor.js';
import type { EmbeddedChat } from './embed.js';
import type { MessageTemplate, TemplateDraft, TemplateStatus } from './templates.js';

/**
 * The channel adapter contract. Adapters own transport concerns only:
 * verification, identity extraction, normalization, media, rendering,
 * sending, delivery status and capability declaration. They never run the
 * agent loop and never touch the database; they reach the network only
 * through `ChannelAdapterDeps.fetch`.
 */

/** A channel kind names an adapter (`WHATSAPP`, `LINE`…): upper snake case, see `CHANNEL_KIND_PATTERN`. */
export type ChannelKind = string;

export type MediaKind = 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';

export interface ChannelCapabilities {
  /** Part types the channel can deliver inbound. */
  inboundParts: readonly InteractionPartType[];
  /** Part types OCSO may render outbound on this channel. */
  outboundParts: readonly InteractionPartType[];
  maxTextLength: number;
  /** Formatting the channel shows: plain text, basic emphasis and lists, or full CommonMark. */
  markdown: 'none' | 'basic' | 'commonmark';
  streaming: boolean;
  deliveryReceipts: boolean;
  interactive: boolean;
  maxMediaBytes: Readonly<Record<MediaKind, number>>;
  allowedMimeTypes: Readonly<Record<MediaKind, readonly string[]>>;
  /** Hours after the last customer message during which free-form replies are allowed; null = no window. */
  sessionWindowHours: number | null;
  /** Identity kinds this channel can address, most preferred first. */
  identityKinds?: readonly string[] | undefined;
  /** Native choice questions: up to `buttons` options as buttons, up to `list` as a list picker. Absent = numbered text. */
  choices?: { buttons: number; list: number } | undefined;
}

/** Transport-neutral HTTP request as received by the API (raw body kept for signatures). */
export interface RawHttpRequest {
  method: 'GET' | 'POST';
  /** Header names lower-cased. */
  headers: Readonly<Record<string, string | undefined>>;
  query: Readonly<Record<string, string | undefined>>;
  rawBody: Buffer | null;
  /** The URL as the provider called it, on OCSO's public origin (for URL-bound signatures). */
  url?: string | undefined;
}

/** Channel configuration with secrets already resolved by OCSO. */
export interface ChannelRuntimeConfig {
  id: string;
  kind: ChannelKind;
  name: string;
  settings: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  /** This channel's public inbound webhook URL, when the kind has one and the public origin is known. */
  webhookUrl?: string | undefined;
}

export type VerificationResult =
  | { kind: 'challenge'; status: 200; body: string }
  | { kind: 'verified' }
  | { kind: 'rejected'; status: 400 | 401 | 403; reason: string };

export interface InboundMessage {
  /** Provider message id: the idempotency key. */
  externalMessageId: string;
  /** Identity namespace, e.g. `line_user`. */
  identityKind: string;
  /** Provider identifier within that namespace. */
  identityValue: string;
  /** Additional identities observed on the same message. */
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  profileName?: string | undefined;
  /** Business-side account that received the message. */
  channelAccountId?: string | undefined;
  receivedAt: Date;
  /** Media parts carry `media.status = 'PENDING'` and `media.source.externalId`. */
  parts: InteractionPart[];
  replyToExternalId?: string | undefined;
  /**
   * The channel verified the primary identity (e.g. a signed-in user the embedding site vouched for). Customer
   * claims present it to tools as `sub` (with `ocso_channel`) only on this channel's conversations, and only when
   * the value is namespaced `<channel id>:<user id>`, so channels never vouch for each other's users.
   */
  identityVerified?: boolean | undefined;
  /** Context the embedding site passed with the sender's session (embeddable kinds), and who vouched for it. */
  hostContext?: InboundHostContext | undefined;
  /**
   * Where replies to this message go, in the adapter's own terms (a Slack channel and thread, a Bot Framework
   * conversation reference). Opaque to OCSO: stored with the inbound message and handed back as
   * `OutboundTarget.replyContext` for the conversation's later outbound messages. At most
   * 16 string values, 4096 bytes of JSON in total; larger contexts are dropped.
   */
  replyContext?: Readonly<Record<string, string>> | undefined;
}

/** An adapter's reply context (`InboundMessage.replyContext`, `OutboundTarget.replyContext`): opaque string values. */
export type ReplyContext = Readonly<Record<string, string>>;

/** Allowlisted key/values from the embedding site: `host` = its backend vouched, `client` = the browser sent them. */
export interface InboundHostContext {
  source: 'host' | 'client';
  values: Readonly<Record<string, string | number | boolean>>;
  at: Date;
}

export interface DeliveryStatusUpdate {
  externalMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  recipientId?: string | undefined;
  errorCode?: string | undefined;
  errorTitle?: string | undefined;
}

/** A provider-announced change of a customer identifier; OCSO re-links the existing customer. */
export interface IdentityUpdate {
  identityKind: string;
  previousValue: string;
  currentValue: string;
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  channelAccountId?: string | undefined;
  occurredAt: Date;
}

/** A provider-announced template review result. */
export interface TemplateStatusUpdate {
  templateId: string;
  name: string;
  language: string;
  status: TemplateStatus;
  reason: string | null;
  occurredAt: Date;
}

export interface InboundEnvelope {
  messages: InboundMessage[];
  statuses: DeliveryStatusUpdate[];
  identityUpdates?: IdentityUpdate[] | undefined;
  templateUpdates?: TemplateStatusUpdate[] | undefined;
  /** Count of payload entries intentionally ignored (unsupported events). */
  ignored: number;
}

export interface FetchedMedia {
  data: Uint8Array;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  filename?: string | undefined;
}

/** Channel-specific payload ready to send; opaque outside the adapter. */
export interface RenderedOutbound {
  kind: ChannelKind;
  payload: Readonly<Record<string, unknown>>;
  /** Part indices from the source interaction that this payload carries. */
  partIndexes: readonly number[];
}

export interface OutboundTarget {
  identityKind: string;
  identityValue: string;
  channelAccountId?: string | undefined;
  /** Time of the customer's last inbound message (session-window checks). */
  lastInboundAt: Date | null;
  /**
   * The `replyContext` of the customer message this outbound message answers: the latest inbound message on
   * this conversation and channel that carried one, up to the agent turn's input (or, for a human or system
   * message, up to that message) — a later customer message elsewhere never redirects it. Absent when none
   * did, e.g. a message OCSO starts.
   */
  replyContext?: Readonly<Record<string, string>> | undefined;
}

export type SendResult =
  | { ok: true; externalMessageId: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      retriable: boolean;
      /** Outside the session window: a template message is required. */
      requiresTemplate?: boolean | undefined;
    };

/** The body a provider expects once an inbound webhook has been persisted. */
export interface WebhookAcknowledgement {
  status: 200;
  contentType: string;
  body: string;
}

/** One step of a read-only provider check; never includes secret values. */
export interface ConnectionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConnectionCheckResult {
  ok: boolean;
  checks: ConnectionCheck[];
}

/**
 * What an adapter gets from OCSO. `fetch` is the only way an adapter reaches
 * the network: OCSO passes its SSRF-guarded egress fetch (public https hosts
 * plus the operator's internal allowlist). Adapters never call the global fetch.
 */
export interface ChannelAdapterDeps {
  fetch: ChannelFetch;
  now: () => Date;
}

/** The fetch adapters are given (the global fetch's shape, minus `Request` inputs). */
export type ChannelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Everything the API and web app know about this kind (form, labels, mark, setup steps). */
  describe(): ChannelKindDescriptor;
  capabilities(config: ChannelRuntimeConfig): ChannelCapabilities;
  /** How staff see a customer identity this channel created, in lists; null for other channels' identity kinds. */
  displayIdentity?(identityKind: string, value: string): string | null;
  /** The public widget protocol; required exactly when the descriptor is `embeddable`. */
  readonly embed?: EmbeddedChat | undefined;
  /** Validate admin-entered settings/secrets; returns human-readable problems. */
  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[];
  /**
   * Authenticate an inbound request before anything is parsed or stored. May be async when verification needs
   * the network (e.g. JWTs checked against a provider's published signing keys, fetched through `deps.fetch`);
   * OCSO always awaits it.
   */
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult | Promise<VerificationResult>;
  parseInbound(req: RawHttpRequest, config: ChannelRuntimeConfig): InboundEnvelope;
  /** Reply for an accepted webhook; when absent the API answers with a JSON ingest summary. */
  webhookAcknowledgement?(): WebhookAcknowledgement;
  /** Download media referenced by an inbound part (size/MIME/host checks applied). */
  fetchMedia(ref: MediaRef, config: ChannelRuntimeConfig): Promise<FetchedMedia>;
  /** Render customer-safe parts into one or more channel payloads (chunking, formatting). */
  render(parts: readonly InteractionPart[], config: ChannelRuntimeConfig): RenderedOutbound[];
  send(target: OutboundTarget, message: RenderedOutbound, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult>;
  /** Read-only check of the stored credentials against the provider; never sends a message. */
  checkConnection?(config: ChannelRuntimeConfig): Promise<ConnectionCheckResult>;
  // Message templates: implement listTemplates, createTemplate and sendTemplate together (and describe `templates`), or none.
  listTemplates?(config: ChannelRuntimeConfig): Promise<MessageTemplate[]>;
  sendTemplate?(target: OutboundTarget, request: TemplateSendRequest, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult>;
  createTemplate?(config: ChannelRuntimeConfig, draft: TemplateDraft): Promise<MessageTemplate>;
  templateStatus?(config: ChannelRuntimeConfig, templateId: string): Promise<MessageTemplate | null>;
  deleteTemplate?(config: ChannelRuntimeConfig, template: { id: string; name: string }): Promise<void>;
}

export interface TemplateSendRequest {
  templateId: string;
  language: string;
  /** Values keyed by TemplateVariable.key. */
  variables: Readonly<Record<string, string>>;
  headerMediaUrl?: string | undefined;
  /** The normalized definition the values were validated against. */
  template: MessageTemplate;
}

/** Resolves an outbound media part to something the provider can fetch or upload. */
export interface OutboundMediaResolver {
  /** Short-lived HTTPS URL the provider can download from. */
  signedUrl(blobKey: string, ttlSeconds: number): Promise<string>;
  read(blobKey: string): Promise<{ data: Uint8Array; mimeType: string; filename?: string | undefined }>;
}
