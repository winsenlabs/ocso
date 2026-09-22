/**
 * Fake `fetch` for contract tests: records every request (URL, headers,
 * parsed JSON body) and answers from a responder. Honors AbortSignal like the
 * real fetch so timeouts/cancellation behave realistically.
 */

export interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Parsed JSON body, or the raw string for non-JSON bodies. */
  body: unknown;
}

export type Responder = (request: CapturedRequest) => Response | Promise<Response>;

export interface FakeFetch {
  fetch: typeof fetch;
  calls: CapturedRequest[];
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export function fakeFetch(responder: Responder): FakeFetch {
  const calls: CapturedRequest[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const url = input instanceof Request ? input.url : String(input);
    const captured: CapturedRequest = { url, method: init?.method ?? 'GET', headers, body: parseBody(init?.body) };
    calls.push(captured);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    const pending = Promise.resolve(responder(captured));
    if (!signal) return pending;
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(
        (r) => {
          signal.removeEventListener('abort', onAbort);
          resolve(r);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  };
  return { fetch: impl as typeof fetch, calls };
}

/** A response that never arrives (until the request is aborted). */
export const never = (): Promise<Response> => new Promise<Response>(() => undefined);

export function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Streams byte chunks with an initial delay (simulated TTFT) and inter-chunk delay. */
export function streamingResponse(
  chunks: readonly Uint8Array[],
  init: { contentType: string; headers?: Record<string, string>; initialDelayMs?: number; chunkDelayMs?: number },
): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await sleep(index === 0 ? (init.initialDelayMs ?? 0) : (init.chunkDelayMs ?? 0));
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': init.contentType, ...init.headers } });
}

const encoder = new TextEncoder();

/** Server-sent events: each entry is one `data:` payload (object → JSON), optional `event:` name. */
export function sseResponse(
  events: ReadonlyArray<{ event?: string; data: unknown }>,
  init: { headers?: Record<string, string>; initialDelayMs?: number; chunkDelayMs?: number; done?: boolean } = {},
): Response {
  const frames = events.map(({ event, data }) =>
    encoder.encode(`${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`),
  );
  if (init.done) frames.push(encoder.encode('data: [DONE]\n\n'));
  return streamingResponse(frames, { contentType: 'text/event-stream', ...init });
}
