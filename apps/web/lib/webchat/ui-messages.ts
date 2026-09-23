import type { UIMessage } from 'ai';
import { safeMediaUrl } from './linkify';
import type { ChatState, LocalAttachment, PendingSend } from './state';
import type { NoticeKind, WebChatMessage, WebChatPart } from './types';

/**
 * OCSO canonical state → AI SDK UI messages (what `useChat` holds and the
 * widget renders). Stable ids keep React keys steady across the optimistic →
 * stored transition: the customer's messages are keyed by clientMessageId,
 * stored messages by interaction id, notices by their system-event id and
 * streaming drafts by turn id.
 */

export type Author = 'customer' | 'agent' | 'human' | 'system';
export type Delivery = 'sending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface OcsoMessageMetadata {
  kind: 'message' | 'notice' | 'draft';
  author: Author;
  /** Assistant name for AI messages, colleague first name for human ones. */
  name: string | null;
  at: string | null;
  interactionId: string | null;
  clientMessageId: string | null;
  /** Only for the customer's own messages. */
  delivery: Delivery | null;
  error: string | null;
  notice: { kind: NoticeKind; name: string | null } | null;
  /** Upload receipts of an outgoing message (the POST body is built from these). */
  attachments: Array<Omit<LocalAttachment, 'previewUrl'>>;
}

export type OcsoDataParts = {
  unavailable: { mediaType: string; filename: string | null };
  /** A question with options (PM/research/11 §5.4 CHOICES); the widget shows buttons. */
  choices: { options: Array<{ id: string; label: string }> };
};

/** Schema of the CHOICES part (@ocso/domain CHOICES_SCHEMA). */
const CHOICES_SCHEMA = 'ocso.choices';

function choicesOf(part: Extract<WebChatPart, { type: 'STRUCTURED' }>): { text: string; options: Array<{ id: string; label: string }> } | null {
  if (part.schema !== CHOICES_SCHEMA || !part.data) return null;
  const text = typeof part.data['text'] === 'string' ? part.data['text'] : '';
  const raw = Array.isArray(part.data['options']) ? (part.data['options'] as unknown[]) : [];
  const options = raw.flatMap((o) => {
    const v = o as { id?: unknown; label?: unknown };
    return typeof v?.id === 'string' && typeof v.label === 'string' && v.label ? [{ id: v.id, label: v.label }] : [];
  });
  return text && options.length ? { text, options } : null;
}

export type OcsoUIMessage = UIMessage<OcsoMessageMetadata, OcsoDataParts>;
export type OcsoUIPart = OcsoUIMessage['parts'][number];

const baseMeta = (patch: Partial<OcsoMessageMetadata> & Pick<OcsoMessageMetadata, 'kind' | 'author'>): OcsoMessageMetadata => ({
  name: null,
  at: null,
  interactionId: null,
  clientMessageId: null,
  delivery: null,
  error: null,
  notice: null,
  attachments: [],
  ...patch,
});

export const uiId = {
  customer: (clientMessageId: string) => `c:${clientMessageId}`,
  message: (interactionId: string) => `m:${interactionId}`,
  notice: (interactionId: string) => `n:${interactionId}`,
  draft: (turnId: string) => `d:${turnId}`,
};

function filename(part: Extract<WebChatPart, { media: unknown }>): string | undefined {
  return part.media.filename;
}

/** One canonical part → UI parts. Media without a safe URL renders as "unavailable", never as a raw link. */
export function toUIParts(parts: readonly WebChatPart[]): OcsoUIPart[] {
  return parts.flatMap((part): OcsoUIPart[] => {
    switch (part.type) {
      case 'TEXT':
        return part.text ? [{ type: 'text', text: part.text, state: 'done' }] : [];
      case 'IMAGE':
      case 'AUDIO':
      case 'VIDEO':
      case 'DOCUMENT': {
        const url = safeMediaUrl(part.url);
        const name = filename(part);
        const file: OcsoUIPart = url
          ? { type: 'file', mediaType: part.media.mimeType, url, ...(name ? { filename: name } : {}) }
          : { type: 'data-unavailable', data: { mediaType: part.media.mimeType, filename: name ?? null } };
        const caption = 'caption' in part && part.caption ? [{ type: 'text' as const, text: part.caption, state: 'done' as const }] : [];
        return [file, ...caption];
      }
      case 'STRUCTURED': {
        const choices = choicesOf(part);
        if (choices) return [{ type: 'text', text: choices.text, state: 'done' }, { type: 'data-choices', data: { options: choices.options } }];
        return part.fallbackText ? [{ type: 'text', text: part.fallbackText, state: 'done' }] : [];
      }
      case 'LOCATION':
        return [{ type: 'text', text: [part.name, part.address, `${part.latitude}, ${part.longitude}`].filter(Boolean).join(' · '), state: 'done' }];
      case 'CONTACT':
        return [{ type: 'text', text: part.contacts.map((c) => c.name).join(', '), state: 'done' }];
      default:
        return [];
    }
  });
}

function deliveryOf(message: WebChatMessage): Delivery {
  switch (message.deliveryStatus) {
    case 'FAILED':
      return 'failed';
    case 'READ':
      return 'read';
    case 'DELIVERED':
      return 'delivered';
    default:
      return 'sent';
  }
}

function fromStored(message: WebChatMessage): OcsoUIMessage {
  const author: Author = message.from;
  return {
    id: author === 'customer' && message.clientMessageId ? uiId.customer(message.clientMessageId) : uiId.message(message.id),
    role: author === 'customer' ? 'user' : 'assistant',
    parts: toUIParts(message.parts),
    metadata: baseMeta({
      kind: 'message',
      author,
      name: message.name,
      at: message.at,
      interactionId: message.id,
      clientMessageId: message.clientMessageId,
      delivery: author === 'customer' ? deliveryOf(message) : null,
    }),
  };
}

/** The optimistic copy of an outgoing message (also what `useChat.sendMessage` submits). */
export function fromPending(pending: PendingSend): OcsoUIMessage {
  const files: OcsoUIPart[] = pending.attachments.map((a) => {
    const url = a.previewUrl ?? '';
    return url.startsWith('blob:') ? { type: 'file', mediaType: a.mimeType, url, filename: a.filename } : { type: 'data-unavailable', data: { mediaType: a.mimeType, filename: a.filename } };
  });
  return {
    id: uiId.customer(pending.clientMessageId),
    role: 'user',
    parts: [...(pending.text ? [{ type: 'text' as const, text: pending.text, state: 'done' as const }] : []), ...files],
    metadata: baseMeta({
      kind: 'message',
      author: 'customer',
      at: pending.at,
      interactionId: pending.interactionId ?? null,
      clientMessageId: pending.clientMessageId,
      delivery: pending.status,
      error: pending.error ?? null,
      attachments: pending.attachments.map(({ previewUrl: _preview, ...rest }) => rest),
    }),
  };
}

export function toUIMessages(state: ChatState): OcsoUIMessage[] {
  const timeline: Array<{ seq: number; message: OcsoUIMessage }> = [
    ...state.messages.map((m) => ({ seq: m.seq, message: fromStored(m) })),
    ...state.notices.map((n) => ({
      seq: n.seq,
      message: {
        id: uiId.notice(n.id),
        role: 'system' as const,
        parts: [],
        metadata: baseMeta({ kind: 'notice', author: 'system', at: n.at, interactionId: n.id, notice: { kind: n.kind, name: n.name } }),
      },
    })),
  ].sort((a, b) => a.seq - b.seq);
  const stored = new Set(timeline.map((t) => t.message.id));
  const pending = state.pending.map(fromPending).filter((m) => !stored.has(m.id));
  const drafts: OcsoUIMessage[] = state.drafts
    .filter((d) => d.text.trim())
    .map((d) => ({
      id: uiId.draft(d.turnId),
      role: 'assistant',
      parts: [{ type: 'text', text: d.text, state: 'streaming' }],
      metadata: baseMeta({ kind: 'draft', author: 'agent', name: state.agentName }),
    }));
  return [...timeline.map((t) => t.message), ...pending, ...drafts];
}
