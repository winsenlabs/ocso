/**
 * The OCSO domain vocabulary plugin contracts speak: interaction parts,
 * media references, delivery statuses and the provider-neutral model request
 * blocks. Plain TypeScript declarations, structurally identical to the types
 * OCSO derives from its own schemas (a repo test fails when they drift).
 */

/** EXPIRED: bytes deleted under the retention policy; the reference stays. */
export type MediaStatus = 'PENDING' | 'STORED' | 'REJECTED' | 'FAILED' | 'EXPIRED';

/** A reference to media bytes. Parts never carry bytes: OCSO stores them in its blob store. */
export interface MediaRef {
  /** Blob store key once the media has been fetched, validated and stored. */
  blobKey?: string | undefined;
  mimeType: string;
  sizeBytes?: number | undefined;
  /** Hex SHA-256 (64 characters). */
  sha256?: string | undefined;
  filename?: string | undefined;
  status: MediaStatus;
  /** Where the media came from, so OCSO can fetch it through the channel (e.g. a provider media id). */
  source?: { channel: string; externalId?: string | undefined } | undefined;
  rejectionReason?: string | undefined;
}

export interface TextPart {
  type: 'TEXT';
  /** 1–32,000 characters. */
  text: string;
}

export interface ImagePart {
  type: 'IMAGE';
  media: MediaRef;
  caption?: string | undefined;
}

export interface AudioPart {
  type: 'AUDIO';
  media: MediaRef;
  durationMs?: number | undefined;
  /** Derived transcript (never authoritative; the audio blob is). */
  transcript?: string | undefined;
  voiceNote?: boolean | undefined;
}

export interface VideoPart {
  type: 'VIDEO';
  media: MediaRef;
  caption?: string | undefined;
}

export interface DocumentPart {
  type: 'DOCUMENT';
  media: MediaRef;
  caption?: string | undefined;
}

export interface LocationPart {
  type: 'LOCATION';
  latitude: number;
  longitude: number;
  name?: string | undefined;
  address?: string | undefined;
}

export interface ContactCard {
  name: string;
  phones: string[];
  emails: string[];
  organization?: string | undefined;
}

export interface ContactPart {
  type: 'CONTACT';
  /** 1–20 contacts. */
  contacts: ContactCard[];
}

/** Channel-neutral structured payloads: button replies, form submissions, cards, choice questions. */
export interface StructuredPart {
  type: 'STRUCTURED';
  schema: string;
  data: Record<string, unknown>;
  /** Human-readable rendering for channels that cannot show the structure. */
  fallbackText?: string | undefined;
}

/** Tool results are internal: never rendered to customer channels. */
export interface ToolResultPart {
  type: 'TOOL_RESULT';
  toolCallId: string;
  toolName: string;
  status: 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'AWAITING_CONFIRMATION';
  summary: Record<string, unknown>;
}

/** One part of an interaction. Channels translate their payloads into these and render these back. */
export type InteractionPart =
  | TextPart
  | ImagePart
  | AudioPart
  | VideoPart
  | DocumentPart
  | LocationPart
  | ContactPart
  | StructuredPart
  | ToolResultPart;

export type InteractionPartType = InteractionPart['type'];

/** Every part type, in OCSO's order. */
export const PART_TYPES = ['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LOCATION', 'CONTACT', 'STRUCTURED', 'TOOL_RESULT'] as const satisfies readonly InteractionPartType[];

/** The provider's view of an outbound message's progress. A status never moves backwards. */
export type DeliveryStatus = 'NOT_APPLICABLE' | 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';

/**
 * Structured-part schema of a choice question. Core writes a question with
 * options as a STRUCTURED part with this schema and `data: ChoicesData`; a
 * channel that declares `capabilities.choices` renders it natively, other
 * channels send `fallbackText`. Taps come back as STRUCTURED parts whose
 * `data.id` is the option id.
 */
export const CHOICES_SCHEMA = 'ocso.choices';

export interface ChoicesData {
  text: string;
  /** 1–10 options; ids ≤ 200 characters, labels ≤ 60. */
  options: { id: string; label: string }[];
}

/** Parts that may ever be rendered to a customer-facing channel. */
export function isCustomerRenderable(part: InteractionPart): boolean {
  return part.type !== 'TOOL_RESULT';
}

/** The choice question in a part, or null when the part is something else (or malformed). */
export function choicesOf(part: InteractionPart): ChoicesData | null {
  if (part.type !== 'STRUCTURED' || part.schema !== CHOICES_SCHEMA) return null;
  const { text, options } = part.data;
  if (typeof text !== 'string' || !text || text.length > 4_000 || !Array.isArray(options) || options.length < 1 || options.length > 10) return null;
  const parsed: ChoicesData['options'] = [];
  for (const option of options as unknown[]) {
    if (!option || typeof option !== 'object') return null;
    const { id, label } = option as Record<string, unknown>;
    if (typeof id !== 'string' || typeof label !== 'string' || !id || !label || id.length > 200 || label.length > 60) return null;
    parsed.push({ id, label });
  }
  return { text, options: parsed };
}

/** "Which product?\n\n1. Cards\n2. Loans": the text form every channel can send. */
export function renderChoicesAsText(data: ChoicesData): string {
  return [data.text, '', ...data.options.map((o, i) => `${i + 1}. ${o.label}`)].join('\n');
}

// ── Model request vocabulary (model providers) ──

/** Where a prompt cache breakpoint sits. Adapters map these to native controls. */
export type CacheBreakpoint = 'AGENT_PREFIX' | 'CONVERSATION_CONTEXT' | 'HISTORY';

export interface SystemBlock {
  /** Component key, e.g. `runtime_contract`, `identity`, `customer_context`. */
  key: string;
  text: string;
  /** Stable blocks are identical across conversations of the same agent version. */
  stable: boolean;
  /** Cache breakpoint placed immediately after this block, if any. */
  breakpointAfter?: CacheBreakpoint | undefined;
}

export type ToolResultOutput = { type: 'json'; value: unknown } | { type: 'text'; value: string } | { type: 'error'; value: string };

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; blobKey: string; mimeType: string }
  | { type: 'file'; blobKey: string; mimeType: string; filename?: string | undefined }
  | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; output: ToolResultOutput };

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool';
  content: ModelContentPart[];
  /** Cache breakpoint placed at the end of this message, if any. */
  breakpointAfter?: CacheBreakpoint | undefined;
}

/** A tool as presented to the model: schema only, never an executor. */
export interface ToolSpec {
  /** Model-facing name (provider-safe charset). */
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the input object. */
  inputSchema: Record<string, unknown>;
}

/** Resolves blob references to bytes inside trusted adapter code. */
export interface MediaResolver {
  resolve(blobKey: string): Promise<{ data: Uint8Array; mimeType: string }>;
}
