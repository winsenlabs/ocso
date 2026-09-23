import { describe, expect, it, vi } from 'vitest';
import { forwardChat } from '../../../app/api/internal-agent/forward';

/** The BFF stream proxy (ADR-020): token in, bytes through, abort propagated. */

const enc = new TextEncoder();

function upstreamStream() {
  let push!: (s: string) => void;
  let end!: () => void;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (s) => controller.enqueue(enc.encode(s));
      end = () => controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return { body, push: (s: string) => push(s), end: () => end(), isCancelled: () => cancelled };
}

describe('forwardChat', () => {
  it('sends the body unchanged with the session token as Bearer', async () => {
    const fetchImpl = vi.fn(async () => new Response('data: {"type":"start"}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
    const body = '{"threadId":null,"message":{"role":"user","parts":[{"type":"text","text":"hi"}]}}';
    await forwardChat({ apiBaseUrl: 'http://api.test', token: 'tok-123', body, signal: new AbortController().signal, correlationId: 'corr-1', fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://api.test/v1/internal-agent/chat');
    expect(init.body).toBe(body);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer tok-123');
    expect(headers.get('x-correlation-id')).toBe('corr-1');
  });

  it('streams chunks as they arrive, without waiting for the end', async () => {
    const up = upstreamStream();
    const fetchImpl = vi.fn(async () => new Response(up.body, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', connection: 'keep-alive' } }));
    const res = await forwardChat({ apiBaseUrl: 'http://api.test', token: 't', body: '{}', signal: new AbortController().signal, fetchImpl });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-vercel-ai-ui-message-stream')).toBe('v1');
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('connection')).toBeNull();

    const reader = res.body!.getReader();
    up.push('data: {"type":"text-delta","delta":"Hel"}\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"Hel"');
    up.push('data: {"type":"text-delta","delta":"lo"}\n\n');
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('"lo"');
    up.end();
    expect((await reader.read()).done).toBe(true);
  });

  it('propagates the browser abort to the upstream request and cancels the body', async () => {
    const up = upstreamStream();
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      upstreamSignal = init.signal ?? undefined;
      return new Response(up.body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const browser = new AbortController();
    const res = await forwardChat({ apiBaseUrl: 'http://api.test', token: 't', body: '{}', signal: browser.signal, fetchImpl: fetchImpl as unknown as typeof fetch });
    browser.abort();
    expect(upstreamSignal?.aborted).toBe(true);
    await res.body!.cancel();
    expect(up.isCancelled()).toBe(true);
  });

  it('passes typed API errors through as JSON (e.g. not configured)', async () => {
    const error = { error: { category: 'validation', code: 'internal_agent_not_configured', message: 'A Tech admin must choose a model profile for Ask OCSO' } };
    const fetchImpl = vi.fn(async () => Response.json(error, { status: 400 }));
    const res = await forwardChat({ apiBaseUrl: 'http://api.test', token: 't', body: '{}', signal: new AbortController().signal, fetchImpl });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(error);
  });

  it('answers 503 when the API is unreachable, and stays quiet when the browser gave up', async () => {
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const res = await forwardChat({ apiBaseUrl: 'http://api.test', token: 't', body: '{}', signal: new AbortController().signal, fetchImpl: down });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('api_unreachable');

    const aborted = new AbortController();
    aborted.abort();
    const gone = await forwardChat({ apiBaseUrl: 'http://api.test', token: 't', body: '{}', signal: aborted.signal, fetchImpl: down });
    expect(gone.status).toBe(499);
  });
});
