/**
 * In-memory fake of OCSO's public web chat API (the wire protocol in
 * apps/api/src/modules/webchat + SPEC C session fields), driven through a fake
 * `fetch`. Tests push SSE events, inject failures and inspect requests.
 */

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: unknown;
}

type Mode = 'anonymous' | 'client' | 'user';

interface Failure {
  status: number;
  code: string;
  headers?: Record<string, string>;
}

export interface FakeMessage {
  id: string;
  seq: number;
  from: 'customer' | 'agent' | 'human';
  name: string | null;
  parts: unknown[];
  deliveryStatus: string;
  at: string;
  turnId: string | null;
  clientMessageId: string | null;
}

const encoder = new TextEncoder();
const BASE = 'https://ocso.test';
const KEY = 'pk_test_1234';

/**
 * `sseSupported: false`: the stream resolves with no readable body (a fetch
 * polyfill that buffers). `rnFetch: true`: React Native's real behaviour: fetch
 * resolves only once the body is complete, so `GET /stream` never resolves
 * (it rejects with AbortError when aborted).
 */
export function fakeServer(options: { mode?: Mode; sseSupported?: boolean; autoReady?: boolean; rnFetch?: boolean } = {}) {
  const mode = options.mode ?? 'anonymous';
  const requests: RecordedRequest[] = [];
  const failures = new Map<string, Failure[]>();
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const validTokens = new Map<string, { vid: string; ref: string | null }>();
  const passes = new Set<string>();
  const messages: FakeMessage[] = [];
  let seq = 0;
  let visitors = 0;
  let uploads = 0;
  let conversationId: string | null = null;
  let status = { mode: 'ai', humanName: null as string | null };

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const error = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { error: { category: 'x', code, message: code } }, headers);

  const bearer = (headers: Record<string, string>) => {
    const m = /^Bearer\s+(\S+)$/i.exec(headers['authorization'] ?? '');
    return m ? validTokens.get(m[1] as string) ?? null : null;
  };

  const issue = (vid: string, ref: string | null) => {
    const token = `wcv1.${vid}.${Math.random().toString(36).slice(2)}`;
    validTokens.set(token, { vid, ref });
    return { token, visitorId: vid, expiresAt: new Date(Date.now() + 86_400_000).toISOString(), authenticated: Boolean(ref) };
  };

  function session(body: Record<string, unknown>): Response {
    const pass = typeof body['sessionPass'] === 'string' ? body['sessionPass'] : null;
    const userToken = typeof body['userToken'] === 'string' ? body['userToken'] : null;
    let passUser: string | null = null;
    if (pass) {
      if (!passes.has(pass)) return error(401, 'session_pass_invalid');
      passes.delete(pass); // single use
      passUser = pass.includes(':user=') ? (pass.split(':user=')[1] as string) : null;
    }
    if (mode === 'client' && !pass) return error(401, 'session_pass_required');
    if (mode === 'user' && !passUser && !userToken) return error(401, 'user_token_required');
    if (userToken && !userToken.startsWith('good.')) return error(401, 'user_token_invalid');
    const previous = typeof body['visitorToken'] === 'string' ? validTokens.get(body['visitorToken']) : undefined;
    const vid = previous?.vid ?? `v_${++visitors}`;
    const ref = userToken ? userToken.slice(5) : passUser ?? previous?.ref ?? null;
    return json(200, issue(vid, ref));
  }

  function history(query: URLSearchParams): Response {
    const after = Number(query.get('afterSeq') ?? 0);
    const list = after > 0 ? messages.filter((m) => m.seq > after).slice(0, 200) : messages.slice(-200);
    return json(200, { conversationId, agentName: 'Maya', messages: list, notices: [], status });
  }

  function post(body: Record<string, unknown>): Response {
    const clientMessageId = body['clientMessageId'] as string;
    const existing = messages.find((m) => m.clientMessageId === clientMessageId);
    if (existing) return json(201, { status: 'duplicate', conversationId, interactionId: existing.id });
    conversationId ??= 'conv_1';
    const parts: unknown[] = [];
    if (typeof body['text'] === 'string') parts.push({ type: 'TEXT', text: body['text'] });
    for (const a of (body['attachments'] as Array<Record<string, unknown>>) ?? []) parts.push({ type: 'IMAGE', media: { mimeType: a['mimeType'], status: 'STORED' }, url: `${BASE}/blobs/${String(a['uploadId'])}` });
    if (body['structured']) parts.push({ type: 'STRUCTURED', ...(body['structured'] as object) });
    const message = addMessage({ from: 'customer', parts, clientMessageId });
    return json(201, { status: 'accepted', conversationId, interactionId: message.id, seq: message.seq, created: true, turnQueued: true });
  }

  function stream(): Response {
    if (options.sseSupported === false) {
      // React Native's fetch: the body cannot be read incrementally.
      return { ok: true, status: 200, headers: new Headers(), body: null, json: async () => ({}), text: async () => '' } as unknown as Response;
    }
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        streams.add(c);
        if (options.autoReady !== false) c.enqueue(encoder.encode(`event: ready\ndata: ${JSON.stringify({ conversationId })}\n\n`));
      },
      cancel() {
        streams.delete(ctl);
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  function addMessage(m: Partial<FakeMessage> & { from: FakeMessage['from']; parts: unknown[] }): FakeMessage {
    const message: FakeMessage = { id: `i_${++seq}`, seq, name: m.from === 'agent' ? 'Maya' : null, deliveryStatus: 'SENT', at: new Date().toISOString(), turnId: null, clientMessageId: null, ...m };
    messages.push(message);
    return message;
  }

  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    if (url.protocol === 'file:') return new Response(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    const prefix = `/public/webchat/${KEY}`;
    if (url.origin !== BASE || !url.pathname.startsWith(prefix)) return error(404, 'not_found');
    const path = url.pathname.slice(prefix.length);
    let body: unknown = init.body;
    if (typeof init.body === 'string' && headers['content-type'] === 'application/json') body = JSON.parse(init.body);
    requests.push({ method, path, query: url.searchParams, headers, body });
    const queued = failures.get(`${method} ${path}`);
    const failure = queued?.shift();
    if (failure) return error(failure.status, failure.code, failure.headers);
    if (method === 'GET' && path === '/config') return json(200, config());
    if (method === 'POST' && path === '/session') return session(body as Record<string, unknown>);
    const who = bearer(headers);
    if (!who) return error(401, 'webchat_token_invalid');
    if (method === 'GET' && path === '/messages') return history(url.searchParams);
    if (method === 'POST' && path === '/messages') return post(body as Record<string, unknown>);
    if (method === 'POST' && path === '/attachments') {
      const type = headers['x-ocso-content-type'] ?? headers['content-type'] ?? 'application/octet-stream';
      return json(201, { uploadId: `webchat/c/${who.vid}/${++uploads}.bin`, mimeType: type, sizeBytes: (init.body as Blob)?.size ?? 0, sha256: 'ab'.repeat(32) });
    }
    if (method === 'POST' && path === '/csat') return json(201, { recorded: true, score: (body as { score: number }).score, receivedAt: new Date().toISOString() });
    if (method === 'GET' && path === '/stream' && options.rnFetch) {
      return new Promise<Response>((_, reject) => {
        const signal = init.signal;
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });
      });
    }
    if (method === 'GET' && path === '/stream') return stream();
    return error(404, 'not_found');
  };

  return {
    baseUrl: BASE,
    publishableKey: KEY,
    fetch,
    requests,
    messages,
    /** Requests matching `METHOD /path`. */
    calls: (route: string) => requests.filter((r) => `${r.method} ${r.path}` === route),
    fail(route: string, failure: Failure, times = 1) {
      const list = failures.get(route) ?? [];
      for (let i = 0; i < times; i++) list.push(failure);
      failures.set(route, list);
    },
    mintPass(user?: string) {
      const pass = `wsp1.${Math.random().toString(36).slice(2)}${user ? `:user=${user}` : ''}`;
      passes.add(pass);
      return pass;
    },
    addMessage,
    setStatus(next: { mode: string; humanName: string | null }) {
      status = next;
    },
    push(event: string, data: unknown) {
      const chunk = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      for (const c of streams) c.enqueue(chunk);
    },
    /** Drop every open stream (server restart, network blip). */
    closeStreams() {
      for (const c of streams) c.close();
      streams.clear();
    },
    get openStreams() {
      return streams.size;
    },
  };
}

export type FakeServer = ReturnType<typeof fakeServer>;

export function config() {
  return {
    name: 'Site chat',
    assistantName: 'Maya',
    branding: { title: 'Help', accentColor: '#0f766e', theme: 'light', position: 'right' },
    inboundParts: ['TEXT', 'IMAGE', 'DOCUMENT', 'STRUCTURED'],
    maxMediaBytes: { IMAGE: 10_485_760, AUDIO: 0, VIDEO: 0, DOCUMENT: 20_971_520 },
    allowedMimeTypes: { IMAGE: ['image/png', 'image/jpeg'], AUDIO: [], VIDEO: [], DOCUMENT: ['application/pdf'] },
    maxTextLength: 8000,
    maxAttachmentsPerMessage: 5,
    allowedOrigins: [],
    hostIdentity: false,
  };
}

/** Wait until `check` passes (polling the event loop), or fail after `ms`. */
export async function until(check: () => boolean | undefined | null, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}
