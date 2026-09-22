import { z } from 'zod';

/**
 * Wire shapes of the public web chat API (apps/api/src/modules/webchat).
 * Every response is validated at the boundary; parts stay OCSO's canonical
 * interaction parts (docs/07 §1) until the view maps them to UI parts.
 */

export const MEDIA_KINDS = ['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

export const WebChatBranding = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  greeting: z.string().optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().catch(undefined),
  theme: z.enum(['light', 'dark', 'auto']).catch('light'),
  position: z.enum(['right', 'left']).catch('right'),
  launcherLabel: z.string().optional(),
});
export type WebChatBranding = z.infer<typeof WebChatBranding>;

const perKind = <T extends z.ZodType>(value: T) => z.object({ IMAGE: value, AUDIO: value, VIDEO: value, DOCUMENT: value });

export const WebChatConfig = z.object({
  name: z.string(),
  assistantName: z.string().nullable(),
  branding: WebChatBranding.catch({ theme: 'light', position: 'right' }),
  inboundParts: z.array(z.string()),
  maxMediaBytes: perKind(z.number().int().nonnegative()),
  allowedMimeTypes: perKind(z.array(z.string())),
  maxTextLength: z.number().int().positive(),
  maxAttachmentsPerMessage: z.number().int().nonnegative(),
  allowedOrigins: z.array(z.string()),
  hostIdentity: z.boolean(),
});
export type WebChatConfig = z.infer<typeof WebChatConfig>;

export const SessionResponse = z.object({
  token: z.string().min(1),
  visitorId: z.string(),
  expiresAt: z.string(),
  authenticated: z.boolean(),
});
export type SessionResponse = z.infer<typeof SessionResponse>;

const Media = z.object({ mimeType: z.string(), filename: z.string().optional(), sizeBytes: z.number().optional(), status: z.string().optional() });

/** Customer-safe canonical part; unknown part types are kept (and ignored by the view). */
export const WebChatPart = z.discriminatedUnion('type', [
  z.object({ type: z.literal('TEXT'), text: z.string() }),
  z.object({ type: z.enum(MEDIA_KINDS), media: Media, url: z.string().optional(), caption: z.string().optional(), transcript: z.string().optional() }),
  z.object({ type: z.literal('STRUCTURED'), schema: z.string(), fallbackText: z.string().optional() }),
  z.object({ type: z.literal('LOCATION'), latitude: z.number(), longitude: z.number(), name: z.string().optional(), address: z.string().optional() }),
  z.object({ type: z.literal('CONTACT'), contacts: z.array(z.object({ name: z.string() })) }),
]);
export type WebChatPart = z.infer<typeof WebChatPart>;

/** Parts the widget does not know (future types, tool results) are dropped rather than failing the message. */
const Parts = z.array(z.unknown()).transform((items) => items.flatMap((item) => {
  const parsed = WebChatPart.safeParse(item);
  return parsed.success ? [parsed.data] : [];
}));

export const WebChatMessage = z.object({
  id: z.string(),
  seq: z.number().int(),
  from: z.enum(['customer', 'agent', 'human']),
  name: z.string().nullable(),
  parts: Parts,
  deliveryStatus: z.string(),
  at: z.string(),
  turnId: z.string().nullable().default(null),
  clientMessageId: z.string().nullable().default(null),
});
export type WebChatMessage = z.infer<typeof WebChatMessage>;

export const NoticeKind = z.enum(['waiting', 'joined', 'ai_resumed', 'resolved']);
export type NoticeKind = z.infer<typeof NoticeKind>;

export const WebChatNotice = z.object({ id: z.string(), seq: z.number().int(), kind: NoticeKind, name: z.string().nullable(), at: z.string() });
export type WebChatNotice = z.infer<typeof WebChatNotice>;

export const ChatMode = z.enum(['ai', 'waiting', 'human', 'closed']);
export type ChatMode = z.infer<typeof ChatMode>;

export const WebChatStatus = z.object({ mode: ChatMode.catch('ai'), humanName: z.string().nullable() });
export type WebChatStatus = z.infer<typeof WebChatStatus>;

export const HistoryResponse = z.object({
  conversationId: z.string().nullable(),
  agentName: z.string().nullable().optional(),
  messages: z.array(WebChatMessage),
  notices: z.array(WebChatNotice).default([]),
  status: WebChatStatus.default({ mode: 'ai', humanName: null }),
});
export type HistoryResponse = z.infer<typeof HistoryResponse>;

export const SendResult = z.object({
  status: z.enum(['accepted', 'duplicate']),
  conversationId: z.string(),
  interactionId: z.string(),
  seq: z.number().int().optional(),
  created: z.boolean().optional(),
  turnQueued: z.boolean().optional(),
});
export type SendResult = z.infer<typeof SendResult>;

export const UploadResult = z.object({ uploadId: z.string(), mimeType: z.string(), sizeBytes: z.number().int(), sha256: z.string().optional() });
export type UploadResult = z.infer<typeof UploadResult>;

/** Body of POST /messages (packages/channels webchat inbound). */
export interface OutgoingMessage {
  clientMessageId: string;
  text?: string;
  attachments: Array<{ uploadId: string; mimeType: string; sizeBytes: number; filename?: string; sha256?: string }>;
}

/** Live stream events (apps/api webchat-stream.ts). */
export const LiveEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('ready'), data: z.object({ conversationId: z.string().nullable().optional() }) }),
  z.object({ event: z.literal('message'), data: WebChatMessage }),
  z.object({ event: z.literal('delta'), data: z.object({ turnId: z.string(), text: z.string() }) }),
  z.object({ event: z.literal('typing'), data: z.object({ turnId: z.string(), status: z.string().optional() }) }),
  z.object({ event: z.literal('idle'), data: z.object({ turnId: z.string() }) }),
  z.object({ event: z.literal('notice'), data: WebChatNotice }),
  z.object({ event: z.literal('status'), data: WebChatStatus }),
  z.object({ event: z.literal('ping'), data: z.unknown() }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
