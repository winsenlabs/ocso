import { z } from 'zod';

/**
 * Canonical multimodal interaction parts (docs/archive/specs/07 §1, build rule §8).
 * Channels translate into these; the runtime, API and UI only ever see these.
 * Media bytes are externalized to BlobStore — parts carry references only.
 */

/** EXPIRED: bytes deleted under the retention policy (docs/archive/specs/15 §8); the reference stays. */
export const MediaStatus = z.enum(['PENDING', 'STORED', 'REJECTED', 'FAILED', 'EXPIRED']);
export type MediaStatus = z.infer<typeof MediaStatus>;

export const MediaRef = z.object({
  /** BlobStore key once the media has been fetched/validated/stored. */
  blobKey: z.string().min(1).optional(),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().length(64).optional(),
  filename: z.string().max(255).optional(),
  status: MediaStatus,
  /** Where the media came from, so a worker can fetch it (e.g. WhatsApp media id). */
  source: z
    .object({
      channel: z.string(),
      externalId: z.string().optional(),
    })
    .optional(),
  rejectionReason: z.string().optional(),
});
export type MediaRef = z.infer<typeof MediaRef>;

export const TextPart = z.object({ type: z.literal('TEXT'), text: z.string().min(1).max(32_000) });
export const ImagePart = z.object({
  type: z.literal('IMAGE'),
  media: MediaRef,
  caption: z.string().max(4_000).optional(),
});
export const AudioPart = z.object({
  type: z.literal('AUDIO'),
  media: MediaRef,
  durationMs: z.number().int().nonnegative().optional(),
  /** Derived transcript (never authoritative; the audio blob is). */
  transcript: z.string().optional(),
  voiceNote: z.boolean().optional(),
});
export const VideoPart = z.object({
  type: z.literal('VIDEO'),
  media: MediaRef,
  caption: z.string().max(4_000).optional(),
});
export const DocumentPart = z.object({
  type: z.literal('DOCUMENT'),
  media: MediaRef,
  caption: z.string().max(4_000).optional(),
});
export const LocationPart = z.object({
  type: z.literal('LOCATION'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  name: z.string().max(500).optional(),
  address: z.string().max(1_000).optional(),
});
export const ContactCard = z.object({
  name: z.string().max(500),
  phones: z.array(z.string().max(64)).default([]),
  emails: z.array(z.string().max(320)).default([]),
  organization: z.string().max(500).optional(),
});
export const ContactPart = z.object({
  type: z.literal('CONTACT'),
  contacts: z.array(ContactCard).min(1).max(20),
});
/** Channel-neutral structured payloads: button replies, form submissions, cards. */
export const StructuredPart = z.object({
  type: z.literal('STRUCTURED'),
  schema: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()),
  /** Human-readable rendering for channels/UIs that cannot show the structure. */
  fallbackText: z.string().max(4_000).optional(),
});
/** Tool results are internal: never rendered to customer channels. */
export const ToolResultPart = z.object({
  type: z.literal('TOOL_RESULT'),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['SUCCEEDED', 'FAILED', 'DENIED', 'AWAITING_CONFIRMATION']),
  summary: z.record(z.string(), z.unknown()).default({}),
});

export const InteractionPart = z.discriminatedUnion('type', [
  TextPart,
  ImagePart,
  AudioPart,
  VideoPart,
  DocumentPart,
  LocationPart,
  ContactPart,
  StructuredPart,
  ToolResultPart,
]);
export type InteractionPart = z.infer<typeof InteractionPart>;
export type InteractionPartType = InteractionPart['type'];

export const PART_TYPES = [
  'TEXT',
  'IMAGE',
  'AUDIO',
  'VIDEO',
  'DOCUMENT',
  'LOCATION',
  'CONTACT',
  'STRUCTURED',
  'TOOL_RESULT',
] as const satisfies readonly InteractionPartType[];

export const MEDIA_PART_TYPES = ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] as const;
export type MediaPart = Extract<InteractionPart, { media: MediaRef }>;

export function isMediaPart(part: InteractionPart): part is MediaPart {
  return (MEDIA_PART_TYPES as readonly string[]).includes(part.type);
}

/** Parts that may ever be rendered to a customer-facing channel. */
export function isCustomerRenderable(part: InteractionPart): boolean {
  return part.type !== 'TOOL_RESULT';
}

/** Plain-text projection used for previews, search and model fallbacks. */
export function partToPlainText(part: InteractionPart): string {
  switch (part.type) {
    case 'TEXT':
      return part.text;
    case 'IMAGE':
      return part.caption ? `[image] ${part.caption}` : '[image]';
    case 'AUDIO':
      return part.transcript ? `[audio] ${part.transcript}` : '[audio]';
    case 'VIDEO':
      return part.caption ? `[video] ${part.caption}` : '[video]';
    case 'DOCUMENT':
      return `[document ${part.media.filename ?? part.media.mimeType}]${part.caption ? ` ${part.caption}` : ''}`;
    case 'LOCATION':
      return `[location ${part.name ?? ''} ${part.latitude},${part.longitude}]`.replace('  ', ' ');
    case 'CONTACT':
      return `[contact ${part.contacts.map((c) => c.name).join(', ')}]`;
    case 'STRUCTURED':
      return part.fallbackText ?? `[${part.schema}]`;
    case 'TOOL_RESULT':
      return `[tool ${part.toolName} ${part.status.toLowerCase()}]`;
  }
}
