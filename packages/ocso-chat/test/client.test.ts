import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOcsoChat, memoryStorage, type OcsoChatClient, type OcsoChatOptions } from '../src/index.js';
import { fakeServer, until, type FakeServer } from './helpers/fake-server.js';

const clients: OcsoChatClient[] = [];

function clientFor(server: FakeServer, extra: Partial<OcsoChatOptions> = {}): OcsoChatClient {
  const client = createOcsoChat({ baseUrl: server.baseUrl, publishableKey: server.publishableKey, fetch: server.fetch, storage: memoryStorage(), ...extra });
  clients.push(client);
  return client;
}

afterEach(() => {
  for (const c of clients.splice(0)) c.disconnect();
  vi.unstubAllGlobals();
});

describe('createOcsoChat: connect', () => {
  it('opens a session, loads config and history, and streams over SSE', async () => {
    const server = fakeServer();
    server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'Welcome back' }] });
    const client = clientFor(server);
    expect(client.getState().status).toBe('idle');
    await client.connect();
    await until(() => client.getState().config !== null && server.openStreams === 1);
    const state = client.getState();
    expect(state.status).toBe('ready');
    expect(state.transport).toBe('sse');
    expect(state.config?.branding.accentColor).toBe('#0f766e');
    expect(state.messages).toMatchObject([{ role: 'assistant', parts: [{ type: 'text', text: 'Welcome back' }], author: { name: 'Maya' } }]);
    expect(server.calls('GET /stream')[0]?.headers['authorization']).toMatch(/^Bearer wcv1\./);
  });

  it('resumes the stored visitor on the next start (sliding renewal)', async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const first = clientFor(server, { storage });
    await first.connect();
    first.disconnect();
    const second = clientFor(server, { storage });
    await second.connect();
    const [a, b] = server.calls('POST /session');
    expect(a?.body).toEqual({});
    expect((b?.body as { visitorToken?: string }).visitorToken).toMatch(/^wcv1\.v_1\./);
  });

  it('is idempotent while connecting', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await Promise.all([client.connect(), client.connect()]);
    expect(server.calls('POST /session')).toHaveLength(1);
  });
});

describe('send', () => {
  it('shows the message optimistically, then marks it sent and swaps in the stored copy', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    const sending = client.send('Where is my card?');
    const optimistic = client.getState().messages.at(-1);
    expect(optimistic).toMatchObject({ role: 'customer', status: 'sending', parts: [{ type: 'text', text: 'Where is my card?' }] });
    await sending;
    const body = server.calls('POST /messages')[0]?.body as { clientMessageId: string; text: string };
    expect(body.clientMessageId).toMatch(/^cm_[0-9a-f]{32}$/);
    expect(body.text).toBe('Where is my card?');
    expect(client.getState().messages.at(-1)).toMatchObject({ id: optimistic?.id, status: 'sent' });
    // The stored copy arrives on the stream: same id, no duplicate.
    server.push('message', server.messages.at(-1));
    await until(() => client.getState().messages.at(-1)?.seq !== undefined);
    expect(client.getState().messages.filter((m) => m.role === 'customer')).toHaveLength(1);
    expect(client.getState().messages.at(-1)?.id).toBe(optimistic?.id);
  });

  it('renews the token once on 401 and retries transient failures honouring Retry-After', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    server.fail('POST /messages', { status: 401, code: 'webchat_token_expired' });
    server.fail('POST /messages', { status: 429, code: 'rate_limited', headers: { 'retry-after': '0' } });
    await client.send('hello');
    expect(server.calls('POST /messages')).toHaveLength(3);
    expect(server.calls('POST /session')).toHaveLength(2);
    expect(client.getState().messages.at(-1)?.status).toBe('sent');
  });

  it('marks a message failed after a permanent error, and retry() delivers it', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    server.fail('POST /messages', { status: 400, code: 'webchat_text_too_long' });
    await expect(client.send('x')).rejects.toMatchObject({ code: 'webchat_text_too_long' });
    const failed = client.getState().messages.at(-1);
    expect(failed).toMatchObject({ status: 'failed', error: 'webchat_text_too_long' });
    await client.retry(failed!.id);
    expect(client.getState().messages.at(-1)?.status).toBe('sent');
    const ids = server.calls('POST /messages').map((r) => (r.body as { clientMessageId: string }).clientMessageId);
    expect(new Set(ids).size).toBe(1); // same idempotency key
  });

  it('uploads browser blobs and React Native files before sending', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    const blob = Object.assign(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { name: 'receipt.png' });
    await client.send({ text: 'see attached', attachments: [blob, { uri: 'file:///tmp/photo.jpg', name: 'photo.jpg', type: 'image/jpeg' }, { size: 3, type: '', name: 'notes.txt' } as Blob & { name: string }] });
    const uploads = server.calls('POST /attachments');
    expect(uploads.map((u) => u.headers['content-type'])).toEqual(['image/png', 'image/jpeg', 'application/octet-stream']);
    expect(uploads[2]?.headers['x-ocso-content-type']).toBe('text/plain');
    const body = server.calls('POST /messages')[0]?.body as { attachments: Array<{ uploadId: string; filename: string }> };
    expect(body.attachments.map((a) => a.filename)).toEqual(['receipt.png', 'photo.jpg', 'notes.txt']);
    expect(body.attachments.every((a) => a.uploadId.startsWith('webchat/'))).toBe(true);
  });

  it('upload() returns a receipt', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    const receipt = await client.upload(new Blob(['%PDF-1.4'], { type: 'application/pdf' }));
    expect(receipt).toMatchObject({ mimeType: 'application/pdf', filename: 'attachment' });
  });
});

describe('live stream', () => {
  it('streams AI deltas as a draft that the stored message replaces', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await until(() => server.openStreams === 1);
    server.push('typing', { turnId: 't1', status: 'THINKING' });
    await until(() => client.getState().typing !== null);
    expect(client.getState().typing).toEqual({ who: 'ai', name: 'Maya' });
    server.push('delta', { turnId: 't1', text: 'Your card ' });
    server.push('delta', { turnId: 't1', text: 'ships today.' });
    await until(() => client.getState().messages.at(-1)?.parts[0]?.type === 'text' && (client.getState().messages.at(-1)?.parts[0] as { text: string }).text === 'Your card ships today.');
    expect(client.getState().messages.at(-1)).toMatchObject({ role: 'assistant', streaming: true, id: 'd:t1' });
    const stored = server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'Your card ships today.' }], turnId: 't1' });
    const seen: string[] = [];
    client.on('message', (m) => seen.push(m.id));
    server.push('message', stored);
    server.push('idle', { turnId: 't1' });
    await until(() => client.getState().typing === null);
    const assistant = client.getState().messages.filter((m) => m.role === 'assistant');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]).toMatchObject({ id: `m:${stored.id}`, seq: stored.seq });
    expect(assistant[0]?.streaming).toBeUndefined();
    expect(seen).toEqual([`m:${stored.id}`]);
  });

  it('reconnects and gap-fills what was sent while disconnected', async () => {
    const server = fakeServer();
    server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'one' }] });
    const client = clientFor(server);
    await client.connect();
    await until(() => server.openStreams === 1 && client.getState().messages.length === 1);
    const statuses: string[] = [];
    client.on('status', (s) => statuses.push(s));
    server.closeStreams();
    await until(() => client.getState().status === 'reconnecting');
    server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'two (missed)' }] });
    client.reconnect();
    await until(() => client.getState().messages.length === 2);
    expect(client.getState().messages.map((m) => (m.parts[0] as { text: string }).text)).toEqual(['one', 'two (missed)']);
    const gapFill = server.calls('GET /messages').at(-1);
    expect(gapFill?.query.get('afterSeq')).toBe('1');
    await until(() => client.getState().status === 'ready');
    expect(statuses).toEqual(['reconnecting', 'ready']);
  });

  it('tracks hand-off notices and mode', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    await until(() => server.openStreams === 1);
    const notices: string[] = [];
    client.on('notice', (n) => notices.push(n.kind));
    server.push('notice', { id: 'e1', seq: 5, kind: 'waiting', name: null, at: new Date().toISOString() });
    await until(() => client.getState().mode === 'waiting');
    server.push('notice', { id: 'e2', seq: 6, kind: 'joined', name: 'Priya', at: new Date().toISOString() });
    await until(() => client.getState().mode === 'human');
    expect(client.getState().humanName).toBe('Priya');
    expect(client.getState().messages.map((m) => m.notice?.kind)).toEqual(['waiting', 'joined']);
    expect(client.getState().messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Priya joined the chat' }]);
    server.push('status', { mode: 'closed', humanName: null });
    await until(() => client.getState().mode === 'resolved');
    expect(notices).toEqual(['waiting', 'joined']);
  });
});

describe('choices', () => {
  it('renders CHOICES as a choices part and sends a tap as a structured reply', async () => {
    const server = fakeServer();
    server.addMessage({
      from: 'agent',
      parts: [{ type: 'STRUCTURED', schema: 'ocso.choices', data: { text: 'Which product?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] }, fallbackText: 'Which product?\n\n1. Cards\n2. Loans' }],
    });
    const client = clientFor(server);
    await client.connect();
    expect(client.getState().messages[0]?.parts).toEqual([{ type: 'choices', prompt: 'Which product?', options: [{ id: 'cards', label: 'Cards' }, { id: 'loans', label: 'Loans' }] }]);
    await client.sendChoice({ id: 'loans', label: 'Loans' });
    const body = server.calls('POST /messages')[0]?.body as Record<string, unknown>;
    expect(body['text']).toBeUndefined();
    expect(body['structured']).toEqual({ schema: 'button_reply', data: { id: 'loans', title: 'Loans', source: 'webchat' }, fallbackText: 'Loans' });
    expect(client.getState().messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Loans' }]);
  });
});

describe('transports', () => {
  it('poll: re-reads history on an interval and never opens the stream', async () => {
    const server = fakeServer();
    const client = clientFor(server, { transport: 'poll', pollIntervalMs: 20 });
    await client.connect();
    await until(() => client.getState().status === 'ready');
    expect(client.getState().transport).toBe('poll');
    server.addMessage({ from: 'human', name: 'Priya', parts: [{ type: 'TEXT', text: 'Hi, Priya here' }] });
    await until(() => client.getState().messages.length === 1);
    expect(client.getState().messages[0]).toMatchObject({ role: 'agent', author: { name: 'Priya' } });
    expect(server.calls('GET /stream')).toHaveLength(0);
  });

  it('auto: falls back to polling when the response body cannot be streamed (React Native)', async () => {
    const server = fakeServer({ sseSupported: false });
    const client = clientFor(server, { pollIntervalMs: 20 });
    await client.connect();
    await until(() => client.getState().transport === 'poll');
    server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'polled' }] });
    await until(() => client.getState().messages.length === 1);
    expect(server.calls('GET /stream')).toHaveLength(1);
    expect(client.getState().status).toBe('ready');
  });
});

describe('transports: React Native', () => {
  it('auto: polls from the start on React Native, whose fetch never resolves a stream request', async () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    const server = fakeServer({ rnFetch: true });
    const client = clientFor(server, { pollIntervalMs: 20 });
    await client.connect();
    expect(client.getState().transport).toBe('poll');
    await until(() => client.getState().status === 'ready');
    server.addMessage({ from: 'agent', parts: [{ type: 'TEXT', text: 'polled' }] });
    await until(() => client.getState().messages.length === 1);
    expect(server.calls('GET /stream')).toHaveLength(0);
  });

  it("transport: 'sse' still streams on React Native (for a streaming fetch such as expo/fetch)", async () => {
    vi.stubGlobal('navigator', { product: 'ReactNative' });
    const server = fakeServer();
    const client = clientFor(server, { transport: 'sse' });
    await client.connect();
    await until(() => server.openStreams === 1);
    expect(client.getState().transport).toBe('sse');
  });

  it("reports 'connecting' until the stream is actually open", async () => {
    const server = fakeServer({ autoReady: false });
    const client = clientFor(server);
    await client.connect();
    await until(() => server.openStreams === 1);
    expect(client.getState().status).toBe('connecting');
    server.push('ready', { conversationId: null });
    await until(() => client.getState().status === 'ready');
  });
});

describe('lifecycle', () => {
  it('disconnect() while the session call is in flight opens no stream and leaves the client idle', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    const connecting = client.connect();
    client.disconnect();
    await connecting;
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getState()).toMatchObject({ status: 'idle', transport: null });
    expect(server.calls('GET /stream')).toHaveLength(0);
    // A later connect still works.
    await client.connect();
    await until(() => server.openStreams === 1 && client.getState().status === 'ready');
  });

  it('connect() right after disconnect() during a start starts again (no stale in-flight promise)', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    const first = client.connect();
    client.disconnect();
    const second = client.connect();
    await Promise.all([first, second]);
    await until(() => server.openStreams === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(server.calls('GET /stream')).toHaveLength(1);
  });
});

describe('terminal errors', () => {
  it('a 403 on the stream stops retrying and surfaces the server code', async () => {
    const server = fakeServer();
    server.fail('GET /stream', { status: 403, code: 'webchat_origin_not_allowed' }, 5);
    const client = clientFor(server);
    const errors: string[] = [];
    client.on('error', (e) => errors.push(e.code));
    await client.connect();
    await until(() => client.getState().status === 'error');
    expect(client.getState().error).toMatchObject({ code: 'webchat_origin_not_allowed' });
    expect(errors).toEqual(['webchat_origin_not_allowed']);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.calls('GET /stream')).toHaveLength(1);
  });

  it('a 403 while polling surfaces the error too', async () => {
    const server = fakeServer();
    const client = clientFor(server, { transport: 'poll', pollIntervalMs: 20 });
    await client.connect();
    await until(() => client.getState().status === 'ready');
    server.fail('GET /messages', { status: 403, code: 'webchat_origin_required' }, 5);
    await until(() => client.getState().status === 'error');
    expect(client.getState().error?.code).toBe('webchat_origin_required');
  });

  it('a 401 whose renewal is refused (no session pass) stops and reports session_pass_required', async () => {
    const server = fakeServer({ mode: 'client' });
    let calls = 0;
    const getSessionPass = async () => (++calls === 1 ? server.mintPass() : 'wsp1.revoked');
    const client = clientFor(server, { getSessionPass, transport: 'poll', pollIntervalMs: 20 });
    await client.connect();
    await until(() => client.getState().status === 'ready');
    server.fail('GET /messages', { status: 401, code: 'webchat_token_invalid' }, 1);
    await until(() => client.getState().status === 'error');
    expect(client.getState().error?.code).toBe('session_pass_invalid');
  });

  it('reconnect() after a terminal error connects again', async () => {
    const server = fakeServer();
    server.fail('GET /stream', { status: 403, code: 'webchat_origin_not_allowed' }, 1);
    const client = clientFor(server);
    await client.connect();
    await until(() => client.getState().status === 'error');
    client.reconnect();
    await until(() => client.getState().status === 'ready' && server.openStreams === 1);
    expect(client.getState().error).toBeNull();
  });
});

describe('upload receipts', () => {
  it('send({ attachments: [receipt] }) posts the stored upload without uploading again', async () => {
    const server = fakeServer();
    const client = clientFor(server);
    await client.connect();
    const receipt = await client.upload(Object.assign(new Blob(['%PDF-1.4'], { type: 'application/pdf' }), { name: 'statement.pdf' }));
    await client.send({ text: 'my statement', attachments: [receipt, Object.assign(new Blob([new Uint8Array([1])], { type: 'image/png' }), { name: 'a.png' })] });
    expect(server.calls('POST /attachments')).toHaveLength(2);
    const body = server.calls('POST /messages')[0]?.body as { attachments: Array<{ uploadId: string; filename: string; mimeType: string }> };
    expect(body.attachments[0]).toMatchObject({ uploadId: receipt.uploadId, filename: 'statement.pdf', mimeType: 'application/pdf' });
    expect(body.attachments[1]?.filename).toBe('a.png');
  });

  it('upload(file, signal) stops when aborted (also during a retry wait)', async () => {
    const server = fakeServer();
    server.fail('POST /attachments', { status: 503, code: 'unavailable' }, 3);
    const client = clientFor(server);
    const controller = new AbortController();
    const uploading = client.upload(new Blob(['x'], { type: 'image/png' }), controller.signal);
    await until(() => server.calls('POST /attachments').length === 1);
    controller.abort();
    await expect(uploading).rejects.toMatchObject({ name: 'AbortError' });
    await new Promise((r) => setTimeout(r, 30));
    expect(server.calls('POST /attachments')).toHaveLength(1);
  });
});
