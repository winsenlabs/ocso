import type { DeliveryStatus, InteractionPart, InteractionPartType, MediaRef, MessageTemplate, TemplateDraft, TemplateStatus } from '@ocso/domain';
import type { ChannelKind, ChannelKindDescriptor } from './descriptor.js';
import type { EmbeddedChat } from './embed.js';

/**
 * ChannelAdapter contract (docs/07 §2). Adapters own transport concerns only:
 * verification, identity extraction, normalization, media, rendering, sending,
 * delivery status, idempotency keys and capability declaration.
 * They never run the agent loop and never touch the database.
 */

export type MediaKind = 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';

export interface ChannelCapabilities {
  /** Part types the channel can deliver inbound. */
  inboundParts: readonly InteractionPartType[];
  /** Part types OCSO may render outbound on this channel. */
  outboundParts: readonly InteractionPartType[];
  maxTextLength: number;
  /** Formatting the channel shows: plain text, basic emphasis and lists (the adapter converts markdown), or full CommonMark. */
  markdown: 'none' | 'basic' | 'commonmark';
  streaming: boolean;
  deliveryReceipts: boolean;
  interactive: boolean;
  maxMediaBytes: Readonly<Record<MediaKind, number>>;
  allowedMimeTypes: Readonly<Record<MediaKind, readonly string[]>>;
  /** Hours after the last customer message during which free-form replies are allowed; null = no window. */
  sessionWindowHours: number | null;
  /** Identity kinds this channel can address, most preferred first; delivery picks the customer's identity by it. */
  identityKinds?: readonly string[] | undefined;
}

/** Transport-neutral HTTP request as received by the API (raw body kept for signatures). */
export interface RawHttpRequest {
  method: 'GET' | 'POST';
  /** Header names lower-cased. */
  headers: Readonly<Record<string, string | undefined>>;
  query: Readonly<Record<string, string | undefined>>;
  rawBody: Buffer | null;
  /**
   * The URL as the provider called it: scheme, host and port of the public
   * origin (OCSO_PUBLIC_URL, not the proxied internal URL), path and query
   * exactly as received. Needed by URL-bound signatures (Twilio).
   */
  url?: string | undefined;
}

/** Channel configuration with secrets already resolved by trusted code. */
export interface ChannelRuntimeConfig {
  id: string;
  kind: ChannelKind;
  name: string;
  settings: Readonly<Record<string, unknown>>;
  secrets: Readonly<Record<string, string>>;
  /** This channel's public inbound webhook URL, when the kind has one and the public origin is known (e.g. Twilio status callbacks). */
  webhookUrl?: string | undefined;
}

export type VerificationResult =
  | { kind: 'challenge'; status: 200; body: string }
  | { kind: 'verified' }
  | { kind: 'rejected'; status: 400 | 401 | 403; reason: string };

export interface InboundMessage {
  /** Provider message id — the idempotency key (e.g. WhatsApp wamid). */
  externalMessageId: string;
  /** Identity namespace, e.g. `whatsapp_phone`, `whatsapp_bsuid`, `webchat_visitor`. */
  identityKind: string;
  /** Provider identifier within that namespace (E.164 phone, BSUID, visitor id). */
  identityValue: string;
  /** Additional identities observed on the same message (e.g. phone alongside BSUID). */
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  profileName?: string | undefined;
  /** Business-side account that received the message (WhatsApp phone_number_id). */
  channelAccountId?: string | undefined;
  receivedAt: Date;
  /** Media parts carry `media.status = 'PENDING'` and `media.source.externalId`. */
  parts: InteractionPart[];
  replyToExternalId?: string | undefined;
}

export interface DeliveryStatusUpdate {
  externalMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  recipientId?: string | undefined;
  errorCode?: string | undefined;
  errorTitle?: string | undefined;
}

/**
 * A provider-announced change of a customer identifier (e.g. WhatsApp BSUID
 * rotation after a phone-number change). Identity resolution re-links the
 * existing CustomerIdentity instead of creating a new customer.
 */
export interface IdentityUpdate {
  identityKind: string;
  previousValue: string;
  currentValue: string;
  /** Other identities known for the same person at the time of the update. */
  alternateIdentities: ReadonlyArray<{ kind: string; value: string }>;
  channelAccountId?: string | undefined;
  occurredAt: Date;
}

/** A provider-announced template review result (Meta `message_template_status_update`). */
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
  /** Identifier changes announced by the provider (absent when the channel has none). */
  identityUpdates?: IdentityUpdate[] | undefined;
  /** Template review results pushed by the provider (absent when it only offers polling). */
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
}

export type SendResult =
  | { ok: true; externalMessageId: string }
  | {
      ok: false;
      errorCode: string;
      message: string;
      retriable: boolean;
      /** Outside the session window — a template message is required. */
      requiresTemplate?: boolean | undefined;
    };

/** The body a provider expects once an inbound webhook has been persisted (e.g. empty TwiML for Twilio). */
export interface WebhookAcknowledgement {
  status: 200;
  contentType: string;
  body: string;
}

/** One step of a read-only provider check (credentials, account state); never includes secret values. */
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
 * What an adapter gets from the composition root. `fetch` is the only way an
 * adapter reaches the network: the composition root passes the SSRF-guarded
 * egress fetch (public https hosts plus the Tech Admin's internal allowlist);
 * tests pass a stub. Adapters never call the global fetch.
 */
export interface ChannelAdapterDeps {
  fetch: ChannelFetch;
  now: () => Date;
}

/** The fetch adapters are given (the global fetch's shape, minus `Request` inputs). */
export type ChannelFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Stand-in for a missing `fetch` dependency: fails loudly instead of reaching the network unguarded. */
export const NO_NETWORK: ChannelFetch = () => Promise.reject(new Error('channel adapter has no network access: the composition root must inject the egress fetch'));

export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Everything the API and web app know about this kind (form, labels, mark, setup steps, public paths). */
  describe(): ChannelKindDescriptor;
  capabilities(config: ChannelRuntimeConfig): ChannelCapabilities;
  /**
   * How staff see a customer identity this channel created, in lists (full
   * values stay in the database and permitted detail views). Return null for
   * identity kinds that are not this channel's; core then masks generically.
   */
  displayIdentity?(identityKind: string, value: string): string | null;
  /** The public widget protocol; required exactly when the descriptor is `embeddable`. */
  readonly embed?: EmbeddedChat | undefined;
  /** Validate admin-entered settings/secrets; returns human-readable problems. */
  validateConfig(settings: unknown, secrets: Readonly<Record<string, string>>): string[];
  verifyRequest(req: RawHttpRequest, config: ChannelRuntimeConfig): VerificationResult;
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

  /*
   * ── Message templates (docs/07 §3). Optional: a kind supports templates when
   * its adapter implements these methods (and describes them in `templates`). ──
   */

  /** Every template the provider holds for this channel, normalized; throws a typed TemplateProviderError. */
  listTemplates?(config: ChannelRuntimeConfig): Promise<MessageTemplate[]>;
  /** Send an approved template; allowed outside the customer-service window. */
  sendTemplate?(target: OutboundTarget, request: TemplateSendRequest, config: ChannelRuntimeConfig, media: OutboundMediaResolver): Promise<SendResult>;
  /** Create the template at the provider and submit it for review (all or nothing). */
  createTemplate?(config: ChannelRuntimeConfig, draft: TemplateDraft): Promise<MessageTemplate>;
  /** Current review state of one template; null when the provider no longer has it. */
  templateStatus?(config: ChannelRuntimeConfig, templateId: string): Promise<MessageTemplate | null>;
  /** Delete a template at the provider. */
  deleteTemplate?(config: ChannelRuntimeConfig, template: { id: string; name: string }): Promise<void>;
}

export interface TemplateSendRequest {
  /** The provider's template id. */
  templateId: string;
  language: string;
  /** Values keyed by TemplateVariable.key. */
  variables: Readonly<Record<string, string>>;
  /** Header media link for templates whose media is chosen at send time. */
  headerMediaUrl?: string | undefined;
  /** The normalized definition (from listTemplates) the values were validated against. */
  template: MessageTemplate;
}

/** Resolves an outbound media part to something the provider can fetch or upload. */
export interface OutboundMediaResolver {
  /** Short-lived HTTPS URL the provider can download from. */
  signedUrl(blobKey: string, ttlSeconds: number): Promise<string>;
  read(blobKey: string): Promise<{ data: Uint8Array; mimeType: string; filename?: string | undefined }>;
}
