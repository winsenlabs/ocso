import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState, type ChatAction, type ChatState, type PendingSend } from '../../../lib/webchat/state';
import type { HistoryResponse, WebChatMessage, WebChatNotice } from '../../../lib/webchat/types';
import { toUIMessages } from '../../../lib/webchat/ui-messages';

const at = '2026-09-22T10:00:00.000Z';
const msg = (patch: Partial<WebChatMessage> & Pick<WebChatMessage, 'id' | 'seq' | 'from'>): WebChatMessage => ({
  name: null,
  parts: [{ type: 'TEXT', text: `text ${patch.id}` }],
  deliveryStatus: 'NOT_APPLICABLE',
  at,
  turnId: null,
  clientMessageId: null,
  ...patch,
});
const history = (patch: Partial<HistoryResponse> = {}): HistoryResponse => ({
  conversationId: 'conv-1',
  agentName: 'Maya',
  messages: [],
  notices: [],
  status: { mode: 'ai', humanName: null },
  ...patch,
});
const run = (...actions: ChatAction[]): ChatState => actions.reduce(chatReducer, initialChatState);
const pending = (id: string, patch: Partial<PendingSend> = {}): PendingSend => ({ clientMessageId: id, text: 'hello', attachments: [], status: 'sending', at, ...patch });

describe('web chat state: OCSO events → canonical state', () => {
  it('dedupes stored messages by interaction id across live events, gap fills and reloads', () => {
    const m1 = msg({ id: 'i-1', seq: 1, from: 'customer', clientMessageId: 'cm_000001' });
    const m2 = msg({ id: 'i-2', seq: 2, from: 'agent', name: 'Maya', turnId: 't-1' });
    const state = run(
      { type: 'history', history: history({ messages: [m1] }), mode: 'replace' },
      { type: 'message', message: m2 },
      { type: 'message', message: m2 },
      { type: 'history', history: history({ messages: [m1, m2] }), mode: 'merge' },
    );
    expect(state.messages.map((m) => m.id)).toEqual(['i-1', 'i-2']);
    expect(state.lastSeq).toBe(2);
  });

  it('streams deltas into a per-turn draft that the stored message replaces', () => {
    let state = run(
      { type: 'typing', turnId: 't-1', status: 'THINKING', now: 1 },
      { type: 'delta', turnId: 't-1', text: 'Thanks — let ', now: 2 },
      { type: 'delta', turnId: 't-1', text: 'me check.', now: 3 },
    );
    expect(state.drafts).toEqual([{ turnId: 't-1', text: 'Thanks — let me check.', updatedAt: 3 }]);
    expect(toUIMessages(state).at(-1)).toMatchObject({ id: 'd:t-1', role: 'assistant', parts: [{ type: 'text', state: 'streaming' }] });

    state = chatReducer(state, { type: 'message', message: msg({ id: 'i-9', seq: 9, from: 'agent', turnId: 't-1', parts: [{ type: 'TEXT', text: 'Thanks — let me check.' }] }) });
    expect(state.drafts).toEqual([]);
    expect(toUIMessages(state).map((m) => m.id)).toEqual(['m:i-9']);
    state = chatReducer(state, { type: 'idle', turnId: 't-1' });
    expect(state.typing).toBeNull();
  });

  it('keeps the rest of a multi-message turn streaming after its first message is stored', () => {
    const state = run(
      { type: 'delta', turnId: 't-2', text: "Of course — I'll connect you with a colleague. ", now: 1 },
      { type: 'delta', turnId: 't-2', text: 'A colleague will', now: 2 },
      { type: 'message', message: msg({ id: 'i-5', seq: 5, from: 'agent', turnId: 't-2', parts: [{ type: 'TEXT', text: "Of course — I'll connect you with a colleague." }] }) },
    );
    expect(state.drafts.map((d) => d.text)).toEqual(['A colleague will']);
    expect(chatReducer(state, { type: 'idle', turnId: 't-2' }).drafts).toEqual([]);
  });

  it('reconciles optimistic sends with the stored copy by clientMessageId, whichever arrives first', () => {
    const stored = msg({ id: 'i-3', seq: 3, from: 'customer', clientMessageId: 'cm_abcdef01', deliveryStatus: 'NOT_APPLICABLE' });
    const liveFirst = run({ type: 'send', pending: pending('cm_abcdef01') }, { type: 'message', message: stored }, { type: 'sent', clientMessageId: 'cm_abcdef01', interactionId: 'i-3', conversationId: 'conv-1' });
    const postFirst = run({ type: 'send', pending: pending('cm_abcdef01') }, { type: 'sent', clientMessageId: 'cm_abcdef01', interactionId: 'i-3', conversationId: 'conv-1' }, { type: 'message', message: stored });
    for (const state of [liveFirst, postFirst]) {
      expect(state.pending).toEqual([]);
      const ui = toUIMessages(state);
      expect(ui).toHaveLength(1);
      // Same React key before and after confirmation: no flicker.
      expect(ui[0]).toMatchObject({ id: 'c:cm_abcdef01', role: 'user', metadata: { delivery: 'sent', interactionId: 'i-3' } });
    }
  });

  it('marks failed sends and lets them be retried or discarded', () => {
    let state = run({ type: 'send', pending: pending('cm_fail0001') }, { type: 'send-failed', clientMessageId: 'cm_fail0001', error: 'network' });
    expect(toUIMessages(state)[0]?.metadata).toMatchObject({ delivery: 'failed', error: 'network' });
    state = chatReducer(state, { type: 'retry', clientMessageId: 'cm_fail0001' });
    expect(state.pending[0]?.status).toBe('sending');
    expect(chatReducer(state, { type: 'discard', clientMessageId: 'cm_fail0001' }).pending).toEqual([]);
  });

  it('orders notices with messages by seq and derives who is driving', () => {
    const waiting: WebChatNotice = { id: 'n-1', seq: 4, kind: 'waiting', name: null, at };
    const joined: WebChatNotice = { id: 'n-2', seq: 6, kind: 'joined', name: 'Priya', at };
    let state = run(
      { type: 'history', history: history({ messages: [msg({ id: 'i-3', seq: 3, from: 'customer' }), msg({ id: 'i-5', seq: 5, from: 'agent' })] }), mode: 'replace' },
      { type: 'notice', notice: waiting },
    );
    expect(state.mode).toBe('waiting');
    state = chatReducer(chatReducer(state, { type: 'notice', notice: joined }), { type: 'notice', notice: joined });
    state = chatReducer(state, { type: 'message', message: msg({ id: 'i-7', seq: 7, from: 'human', name: 'Priya' }) });
    expect(state).toMatchObject({ mode: 'human', humanName: 'Priya' });
    expect(toUIMessages(state).map((m) => m.id)).toEqual(['m:i-3', 'n:n-1', 'm:i-5', 'n:n-2', 'm:i-7']);
    expect(toUIMessages(state).at(-1)?.metadata).toMatchObject({ author: 'human', name: 'Priya' });
    expect(chatReducer(state, { type: 'status', status: { mode: 'closed', humanName: null } }).mode).toBe('closed');
  });

  it('maps canonical parts to safe UI parts: media only with safe URLs, captions as text', () => {
    const state = run({
      type: 'message',
      message: msg({
        id: 'i-1',
        seq: 1,
        from: 'agent',
        parts: [
          { type: 'IMAGE', media: { mimeType: 'image/png', filename: 'receipt.png' }, url: 'http://localhost:3440/blobs/k?exp=1&sig=x', caption: 'Your receipt' },
          { type: 'DOCUMENT', media: { mimeType: 'application/pdf', filename: 'x.pdf' }, url: 'javascript:alert(1)' },
          { type: 'STRUCTURED', schema: 'buttons', fallbackText: 'Choose an option' },
        ],
      }),
    });
    expect(toUIMessages(state)[0]?.parts).toEqual([
      { type: 'file', mediaType: 'image/png', url: 'http://localhost:3440/blobs/k?exp=1&sig=x', filename: 'receipt.png' },
      { type: 'text', text: 'Your receipt', state: 'done' },
      { type: 'data-unavailable', data: { mediaType: 'application/pdf', filename: 'x.pdf' } },
      { type: 'text', text: 'Choose an option', state: 'done' },
    ]);
  });

  it('drops stale typing and drafts on tick', () => {
    const state = run({ type: 'typing', turnId: 't-1', status: 'THINKING', now: 0 }, { type: 'tick', now: 60_000 });
    expect(state.typing).toBeNull();
    const draft = run({ type: 'delta', turnId: 't-2', text: 'Hel', now: 0 }, { type: 'tick', now: 130_000 });
    expect(draft.drafts).toEqual([]);
  });
});
