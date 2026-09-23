import { ChatApiError } from './api.js';
import type { LiveStatus } from './live.js';
import type { CoreState, PendingSend } from './reducer.js';
import type { ChatError, ChatMessage, ChatNotice, ChatStatus, ConversationMode, NoticeKind, Part } from './types.js';
import type { WireMessage, WireMode, WirePart } from './wire.js';

/**
 * Canonical state → the public message list. Stable ids keep UI keys steady
 * across the optimistic → stored transition: the customer's messages are
 * keyed by clientMessageId (`c:`), stored messages by interaction id (`m:`),
 * notices by system-event id (`n:`) and streaming drafts by turn id (`d:`).
 */

/** Schema of the CHOICES part (@ocso/domain CHOICES_SCHEMA). */
export const CHOICES_SCHEMA = 'ocso.choices';
/** Schema of a tapped choice sent back (same as other channels' button replies). */
export const CHOICE_REPLY_SCHEMA = 'button_reply';

export const messageId = {
  customer: (clientMessageId: string) => `c:${clientMessageId}`,
  message: (interactionId: string) => `m:${interactionId}`,
  notice: (id: string) => `n:${id}`,
  draft: (turnId: string) => `d:${turnId}`,
};

const HTTP_URL = /^https?:\/\/[^\s<>"'`]+$/i;

/**
 * Media URLs from the API are signed absolute http(s) URLs (or paths on the
 * OCSO origin); local previews are blob:/file: URIs this client created.
 */
export function safeMediaUrl(value: string | null | undefined, baseUrl: string): string | null {
  if (!value) return null;
  if (/^(blob:|file:|content:|ph:|assets-library:)/i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return baseUrl.replace(/\/+$/, '') + value;
  return HTTP_URL.test(value) ? value : null;
}

function choicesOf(part: Extract<WirePart, { type: 'STRUCTURED' }>): { prompt: string; options: Array<{ id: string; label: string }> } | null {
  if (part.schema !== CHOICES_SCHEMA || !part.data) return null;
  const prompt = typeof part.data['text'] === 'string' ? part.data['text'] : '';
  const raw = Array.isArray(part.data['options']) ? (part.data['options'] as unknown[]) : [];
  const options = raw.flatMap((o) => {
    const v = o as { id?: unknown; label?: unknown } | null;
    return v && typeof v.id === 'string' && typeof v.label === 'string' && v.label ? [{ id: v.id, label: v.label }] : [];
  });
  return options.length ? { prompt, options } : null;
}

const MEDIA_KIND = { IMAGE: 'image', AUDIO: 'audio', VIDEO: 'video', DOCUMENT: 'document' } as const;

export function toParts(parts: readonly WirePart[], baseUrl: string): Part[] {
  return parts.flatMap((part): Part[] => {
    switch (part.type) {
      case 'TEXT':
        return part.text ? [{ type: 'text', text: part.text }] : [];
      case 'IMAGE':
      case 'AUDIO':
      case 'VIDEO':
      case 'DOCUMENT': {
        const url = safeMediaUrl(part.url, baseUrl);
        const name = part.media.filename;
        const media: Part = url
          ? { type: 'media', kind: MEDIA_KIND[part.type], url, mime: part.media.mimeType, ...(name ? { name } : {}) }
          : { type: 'unavailable', reason: part.media.status === 'STORED' || !part.media.status ? 'no_url' : part.media.status.toLowerCase() };
        return part.caption ? [media, { type: 'text', text: part.caption }] : [media];
      }
      case 'STRUCTURED': {
        const choices = choicesOf(part);
        if (choices) return [{ type: 'choices', ...(choices.prompt ? { prompt: choices.prompt } : {}), options: choices.options }];
        return part.fallbackText ? [{ type: 'text', text: part.fallbackText }] : [];
      }
      case 'LOCATION':
        return [{ type: 'text', text: [part.name, part.address, `${part.latitude}, ${part.longitude}`].filter(Boolean).join(' · ') }];
      case 'CONTACT':
        return [{ type: 'text', text: part.contacts.map((c) => c.name).join(', ') }];
      default:
        return [];
    }
  });
}

function fromStored(message: WireMessage, baseUrl: string): ChatMessage {
  const role = message.from === 'customer' ? 'customer' : message.from === 'agent' ? 'assistant' : 'agent';
  return {
    id: role === 'customer' && message.clientMessageId ? messageId.customer(message.clientMessageId) : messageId.message(message.id),
    role,
    parts: toParts(message.parts, baseUrl),
    createdAt: message.at,
    seq: message.seq,
    ...(role === 'customer' ? { status: message.deliveryStatus === 'FAILED' ? ('failed' as const) : ('sent' as const) } : {}),
    ...(message.name ? { author: { name: message.name } } : {}),
  };
}

function mediaKindOf(mime: string): 'image' | 'audio' | 'video' | 'document' {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}

export function fromPending(pending: PendingSend): ChatMessage {
  const files: Part[] = pending.attachments.map((a) =>
    a.previewUrl ? { type: 'media', kind: mediaKindOf(a.mimeType), url: a.previewUrl, name: a.filename, mime: a.mimeType } : { type: 'unavailable', reason: 'no_preview' },
  );
  const text = pending.text || pending.structured?.fallbackText || '';
  return {
    id: messageId.customer(pending.clientMessageId),
    role: 'customer',
    parts: [...(text ? [{ type: 'text' as const, text }] : []), ...files],
    createdAt: pending.at,
    status: pending.status,
    ...(pending.error ? { error: pending.error } : {}),
  };
}

const NOTICE_TEXT: Record<NoticeKind, (name: string | null) => string> = {
  waiting: () => 'Connecting you with a member of our team…',
  joined: (name) => (name ? `${name} joined the chat` : 'A member of our team joined the chat'),
  ai_resumed: (name) => (name ? `${name} is back to help` : 'The assistant is back to help'),
  resolved: () => 'This conversation was resolved',
};

export function noticeText(kind: NoticeKind, name: string | null): string {
  return NOTICE_TEXT[kind](name);
}

export function toMessages(state: CoreState, baseUrl: string): ChatMessage[] {
  const timeline: Array<{ seq: number; message: ChatMessage }> = [
    ...state.messages.map((m) => ({ seq: m.seq, message: fromStored(m, baseUrl) })),
    ...state.notices.map((n) => ({
      seq: n.seq,
      message: {
        id: messageId.notice(n.id),
        role: 'system' as const,
        parts: [{ type: 'text' as const, text: noticeText(n.kind, n.name) }],
        createdAt: n.at,
        seq: n.seq,
        notice: { kind: n.kind, name: n.name },
      },
    })),
  ].sort((a, b) => a.seq - b.seq);
  const stored = new Set(timeline.map((t) => t.message.id));
  const pending = state.pending.map(fromPending).filter((m) => !stored.has(m.id));
  const drafts: ChatMessage[] = state.drafts
    .filter((d) => d.text.trim())
    .map((d) => ({
      id: messageId.draft(d.turnId),
      role: 'assistant',
      parts: [{ type: 'text', text: d.text }],
      createdAt: new Date(d.updatedAt).toISOString(),
      streaming: true,
      ...(state.agentName ? { author: { name: state.agentName } } : {}),
    }));
  return [...timeline.map((t) => t.message), ...pending, ...drafts];
}

export function toNotices(state: CoreState): ChatNotice[] {
  return state.notices.map((n) => ({ id: n.id, kind: n.kind, name: n.name, at: n.at }));
}

export function publicMode(mode: WireMode): ConversationMode {
  return mode === 'closed' ? 'resolved' : mode;
}

export type Phase = 'idle' | 'starting' | 'started' | 'failed';

/** Public status from the client lifecycle phase and the live transport's state. */
export function chatStatus(phase: Phase, live: LiveStatus): ChatStatus {
  if (phase === 'idle') return 'idle';
  if (phase === 'failed') return 'error';
  if (phase === 'starting') return 'connecting';
  switch (live) {
    case 'connecting':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    case 'offline':
      return 'offline';
    case 'stopped':
      return 'idle';
    default:
      return 'ready';
  }
}

export function toChatError(err: unknown): ChatError {
  if (err instanceof ChatApiError) return { code: err.code, message: err.message };
  return { code: 'unexpected', message: (err as Error)?.message ?? 'Something went wrong' };
}
