import type { UIMessageChunk } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { WebChatApi, WebChatApiError } from '../../../lib/webchat/api';
import type { LiveConnection } from '../../../lib/webchat/live';
import type { VisitorSession } from '../../../lib/webchat/session';
import type { PendingSend } from '../../../lib/webchat/state';
import { createChatStore } from '../../../lib/webchat/store';
import { OcsoChatTransport, toOutgoing } from '../../../lib/webchat/transport';
import { fromPending } from '../../../lib/webchat/ui-messages';

const pending: PendingSend = {
  clientMessageId: 'cm_0123456789abcdef',
  text: 'My card was charged twice',
  attachments: [{ uploadId: 'webchat/ch/abc/f.png', mimeType: 'image/png', sizeBytes: 120, filename: 'receipt.png', sha256: 'a'.repeat(64), previewUrl: 'blob:http://x/1' }],
  status: 'sending',
  at: '2026-09-22T10:00:00.000Z',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function setup(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    if (next instanceof Error) throw next;
    return next;
  });
  const api = new WebChatApi('pk_test_0001', fetchImpl as unknown as typeof fetch);
  let token = 'wcv1.old.token';
  const session = {
    get token() {
      return token;
    },
    start: vi.fn(async () => ({ token, authenticated: false })),
    refresh: vi.fn(async () => {
      token = 'wcv1.new.token';
      return { token, authenticated: false };
    }),
  } as unknown as VisitorSession;
  const store = createChatStore();
  store.dispatch({ type: 'send', pending });
  const reconnectNow = vi.fn();
  const transport = new OcsoChatTransport({ api, session, store, live: () => ({ reconnectNow }) as unknown as LiveConnection, sleep: async () => undefined });
  return { transport, store, calls, session, reconnectNow };
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const accepted = { status: 'accepted', conversationId: 'conv-1', interactionId: 'i-42', seq: 7, created: true, turnQueued: true };
const send = (transport: OcsoChatTransport) =>
  transport.sendMessages({ trigger: 'submit-message', chatId: 'c', messageId: undefined, messages: [fromPending(pending)], abortSignal: undefined });

describe('OcsoChatTransport', () => {
  it('builds the POST body from the UI message: text parts + upload receipts, never preview URLs', () => {
    expect(toOutgoing(fromPending(pending))).toEqual({
      clientMessageId: 'cm_0123456789abcdef',
      text: 'My card was charged twice',
      attachments: [{ uploadId: 'webchat/ch/abc/f.png', mimeType: 'image/png', sizeBytes: 120, filename: 'receipt.png', sha256: 'a'.repeat(64) }],
    });
  });

  it('maps sendMessages to POST /messages and returns an empty stream (replies arrive on the live stream)', async () => {
    const { transport, store, calls } = setup([json(accepted, 201)]);
    const chunks = await drain(await send(transport));
    expect(chunks).toEqual([]);
    expect(calls[0]?.url).toBe('/public/webchat/pk_test_0001/messages');
    expect(calls[0]?.init.method).toBe('POST');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer wcv1.old.token');
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ clientMessageId: 'cm_0123456789abcdef', text: 'My card was charged twice' });
    expect(store.getState().pending[0]).toMatchObject({ status: 'sent', interactionId: 'i-42' });
    expect(store.getState().conversationId).toBe('conv-1');
  });

  it('retries network and 5xx failures with the same idempotency key', async () => {
    const { transport, store, calls } = setup([new TypeError('Failed to fetch'), json({ error: { code: 'internal' } }, 503), json(accepted, 201)]);
    await drain(await send(transport));
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((c) => JSON.parse(String(c.init.body)).clientMessageId))).toEqual(new Set(['cm_0123456789abcdef']));
    expect(store.getState().pending[0]?.status).toBe('sent');
  });

  it('renews an expired visitor token once on 401', async () => {
    const { transport, calls, session } = setup([json({ error: { code: 'webchat_token_expired' } }, 401), json(accepted, 201)]);
    await drain(await send(transport));
    expect(session.refresh).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe('Bearer wcv1.new.token');
  });

  it('marks the message failed on a validation error without retrying', async () => {
    const { transport, store, calls } = setup([json({ error: { code: 'webchat_invalid_message', message: 'bad' } }, 400)]);
    await expect(send(transport)).rejects.toBeInstanceOf(WebChatApiError);
    expect(calls).toHaveLength(1);
    expect(store.getState().pending[0]).toMatchObject({ status: 'failed', error: 'webchat_invalid_message' });
  });

  it('reconnectToStream reconnects the live SSE stream and never fabricates a reply stream', async () => {
    const { transport, reconnectNow } = setup([]);
    await expect(transport.reconnectToStream()).resolves.toBeNull();
    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });
});
