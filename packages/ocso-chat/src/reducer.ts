import type { WireHistory, WireMessage, WireMode, WireNotice, WireStatus } from './wire.js';

/**
 * Canonical chat state (copied from OCSO's widget, apps/web/lib/webchat/state.ts).
 * OCSO's server is the source of truth: stored messages and notices are keyed
 * by interaction id (live events, gap fills and reloads can never duplicate
 * them); optimistic sends are keyed by clientMessageId until the stored copy
 * arrives; streamed AI text is a per-turn draft that the stored message
 * replaces. Pure.
 */

export interface LocalAttachment {
  uploadId: string;
  mimeType: string;
  sizeBytes: number;
  filename: string;
  sha256?: string | undefined;
  /** Local preview (object URL in browsers, file uri in React Native). */
  previewUrl?: string | undefined;
}

export interface PendingSend {
  clientMessageId: string;
  text: string;
  attachments: LocalAttachment[];
  structured?: { schema: string; data: Record<string, unknown>; fallbackText?: string } | undefined;
  status: 'sending' | 'sent' | 'failed';
  error?: string | undefined;
  at: string;
  interactionId?: string | undefined;
}

export interface Draft {
  turnId: string;
  text: string;
  updatedAt: number;
}

export interface CoreState {
  loaded: boolean;
  conversationId: string | null;
  agentName: string | null;
  messages: WireMessage[];
  notices: WireNotice[];
  pending: PendingSend[];
  drafts: Draft[];
  typing: { turnId: string; status: string | null; at: number } | null;
  mode: WireMode;
  humanName: string | null;
  /** Highest seq seen (messages and notices share the conversation's seq space). */
  lastSeq: number;
}

export type CoreAction =
  | { type: 'history'; history: WireHistory; mode: 'replace' | 'merge' }
  | { type: 'message'; message: WireMessage }
  | { type: 'delta'; turnId: string; text: string; now: number }
  | { type: 'typing'; turnId: string; status: string | null; now: number }
  | { type: 'idle'; turnId: string }
  | { type: 'notice'; notice: WireNotice }
  | { type: 'status'; status: WireStatus }
  | { type: 'send'; pending: PendingSend }
  | { type: 'sent'; clientMessageId: string; interactionId: string; conversationId: string }
  | { type: 'send-failed'; clientMessageId: string; error: string }
  | { type: 'retry'; clientMessageId: string }
  | { type: 'discard'; clientMessageId: string }
  | { type: 'tick'; now: number }
  | { type: 'reset' };

/** Typing without any text for this long is considered stale (the turn died silently). */
export const TYPING_STALE_MS = 45_000;
/** A draft that stopped growing this long ago is dropped; the stored message (or gap fill) wins. */
export const DRAFT_STALE_MS = 120_000;

export const initialCoreState: CoreState = {
  loaded: false,
  conversationId: null,
  agentName: null,
  messages: [],
  notices: [],
  pending: [],
  drafts: [],
  typing: null,
  mode: 'ai',
  humanName: null,
  lastSeq: 0,
};

const bySeq = <T extends { seq: number }>(a: T, b: T) => a.seq - b.seq;

function upsert<T extends { id: string; seq: number }>(list: readonly T[], items: readonly T[]): T[] {
  const map = new Map(list.map((item) => [item.id, item]));
  for (const item of items) map.set(item.id, item);
  return [...map.values()].sort(bySeq);
}

const maxSeq = (...lists: ReadonlyArray<ReadonlyArray<{ seq: number }>>) => Math.max(0, ...lists.reduce<number[]>((acc, l) => acc.concat(l.map((i) => i.seq)), []));

const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Remove the stored message's text from the front of its turn's draft (a turn may send several messages). */
function reconcileDraft(drafts: readonly Draft[], message: WireMessage): Draft[] {
  if (message.from !== 'agent' || !message.turnId) return [...drafts];
  const stored = normalize(message.parts.map((p) => (p.type === 'TEXT' ? p.text : '')).join(' '));
  return drafts.flatMap((d) => {
    if (d.turnId !== message.turnId) return [d];
    const draft = normalize(d.text);
    if (!stored || !draft.startsWith(stored)) return [];
    const rest = draft.slice(stored.length).trim();
    return rest ? [{ ...d, text: rest }] : [];
  });
}

function withoutConfirmed(pending: readonly PendingSend[], messages: readonly WireMessage[]): PendingSend[] {
  const ids = new Set(messages.map((m) => m.id));
  const clientIds = new Set(messages.flatMap((m) => (m.clientMessageId ? [m.clientMessageId] : [])));
  return pending.filter((p) => !clientIds.has(p.clientMessageId) && !(p.interactionId && ids.has(p.interactionId)));
}

function modeAfterNotice(notice: WireNotice, state: CoreState): Pick<CoreState, 'mode' | 'humanName'> {
  switch (notice.kind) {
    case 'waiting':
      return { mode: 'waiting', humanName: null };
    case 'joined':
      return { mode: 'human', humanName: notice.name };
    case 'ai_resumed':
      return { mode: 'ai', humanName: null };
    case 'resolved':
      return { mode: 'closed', humanName: null };
    default:
      return { mode: state.mode, humanName: state.humanName };
  }
}

function updatePending(state: CoreState, clientMessageId: string, patch: Partial<PendingSend>): CoreState {
  return { ...state, pending: state.pending.map((p) => (p.clientMessageId === clientMessageId ? { ...p, ...patch } : p)) };
}

export function coreReducer(state: CoreState, action: CoreAction): CoreState {
  switch (action.type) {
    case 'history': {
      const h = action.history;
      const messages = action.mode === 'replace' ? [...h.messages].sort(bySeq) : upsert(state.messages, h.messages);
      const notices = action.mode === 'replace' ? [...h.notices].sort(bySeq) : upsert(state.notices, h.notices);
      const drafts = h.messages.reduce<Draft[]>((acc, m) => reconcileDraft(acc, m), state.drafts);
      return {
        ...state,
        loaded: true,
        conversationId: h.conversationId ?? state.conversationId,
        agentName: h.agentName ?? state.agentName,
        messages,
        notices,
        drafts,
        pending: withoutConfirmed(state.pending, messages),
        mode: h.status.mode,
        humanName: h.status.humanName,
        lastSeq: Math.max(action.mode === 'replace' ? 0 : state.lastSeq, maxSeq(messages, notices)),
      };
    }
    case 'message': {
      const m = action.message;
      const messages = upsert(state.messages, [m]);
      const typing = m.from === 'human' ? null : state.typing;
      return { ...state, messages, typing, drafts: reconcileDraft(state.drafts, m), pending: withoutConfirmed(state.pending, [m]), lastSeq: Math.max(state.lastSeq, m.seq) };
    }
    case 'delta': {
      const existing = state.drafts.find((d) => d.turnId === action.turnId);
      const drafts = existing
        ? state.drafts.map((d) => (d.turnId === action.turnId ? { ...d, text: d.text + action.text, updatedAt: action.now } : d))
        : [...state.drafts, { turnId: action.turnId, text: action.text, updatedAt: action.now }];
      return { ...state, drafts, typing: { turnId: action.turnId, status: 'WRITING', at: action.now } };
    }
    case 'typing':
      return { ...state, typing: { turnId: action.turnId, status: action.status, at: action.now } };
    case 'idle':
      return {
        ...state,
        drafts: state.drafts.filter((d) => d.turnId !== action.turnId),
        typing: state.typing?.turnId === action.turnId ? null : state.typing,
      };
    case 'notice': {
      if (state.notices.some((n) => n.id === action.notice.id)) return state;
      const notices = upsert(state.notices, [action.notice]);
      return { ...state, notices, ...modeAfterNotice(action.notice, state), lastSeq: Math.max(state.lastSeq, action.notice.seq) };
    }
    case 'status':
      return { ...state, mode: action.status.mode, humanName: action.status.humanName };
    case 'send':
      return { ...state, pending: [...state.pending.filter((p) => p.clientMessageId !== action.pending.clientMessageId), action.pending] };
    case 'sent': {
      const confirmed = state.messages.some((m) => m.id === action.interactionId);
      const next = { ...state, conversationId: state.conversationId ?? action.conversationId };
      return confirmed
        ? { ...next, pending: next.pending.filter((p) => p.clientMessageId !== action.clientMessageId) }
        : updatePending(next, action.clientMessageId, { status: 'sent', interactionId: action.interactionId, error: undefined });
    }
    case 'send-failed':
      return updatePending(state, action.clientMessageId, { status: 'failed', error: action.error });
    case 'retry':
      return updatePending(state, action.clientMessageId, { status: 'sending', error: undefined });
    case 'discard':
      return { ...state, pending: state.pending.filter((p) => p.clientMessageId !== action.clientMessageId) };
    case 'tick': {
      const drafts = state.drafts.filter((d) => action.now - d.updatedAt < DRAFT_STALE_MS);
      const typingStale = state.typing && action.now - state.typing.at > TYPING_STALE_MS && !drafts.some((d) => d.turnId === state.typing?.turnId);
      if (drafts.length === state.drafts.length && !typingStale) return state;
      return { ...state, drafts, typing: typingStale ? null : state.typing };
    }
    case 'reset':
      return initialCoreState;
    default:
      return state;
  }
}
