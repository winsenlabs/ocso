/**
 * Streaming proxy for Ask OCSO (ADR-020: the browser never calls the API or
 * sees the token). The request body goes to POST /v1/internal-agent/chat with
 * the session token as Bearer; the UI message stream (SSE) comes back
 * byte-for-byte, unbuffered. Aborting the browser request aborts the
 * upstream fetch, which closes the API response and stops the model call.
 */

export interface ForwardChatOptions {
  apiBaseUrl: string;
  token: string;
  /** Raw JSON body from the browser, forwarded unchanged. */
  body: string;
  signal: AbortSignal;
  correlationId?: string | null | undefined;
  fetchImpl?: typeof fetch;
}

/** Stream headers worth keeping; hop-by-hop and length headers are dropped. */
const PASS_HEADERS = ['content-type', 'x-vercel-ai-ui-message-stream', 'x-correlation-id'] as const;

export const MAX_CHAT_BODY_BYTES = 64 * 1024;

export function jsonError(status: number, category: string, code: string, message: string): Response {
  return Response.json({ error: { category, code, message } }, { status });
}

export async function forwardChat(options: ForwardChatOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = new Headers({
    authorization: `Bearer ${options.token}`,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  });
  if (options.correlationId) headers.set('x-correlation-id', options.correlationId);

  let upstream: Response;
  try {
    upstream = await fetchImpl(`${options.apiBaseUrl}/v1/internal-agent/chat`, {
      method: 'POST',
      headers,
      body: options.body,
      signal: options.signal,
      cache: 'no-store',
    });
  } catch (err) {
    if (options.signal.aborted) return new Response(null, { status: 499 });
    const timedOut = err instanceof Error && err.name === 'TimeoutError';
    return jsonError(timedOut ? 504 : 503, timedOut ? 'timeout' : 'unreachable', timedOut ? 'api_timeout' : 'api_unreachable', 'The OCSO API is not reachable.');
  }

  if (!upstream.ok || !upstream.body) {
    // Typed API errors (e.g. 400 internal_agent_not_configured) pass through as JSON.
    const text = await upstream.text().catch(() => '');
    return new Response(text || null, {
      status: upstream.ok ? 502 : upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  }

  const out = new Headers({
    // no-transform keeps compression middleware from buffering the event stream.
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  for (const name of PASS_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
