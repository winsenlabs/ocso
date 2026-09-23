import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { EgressBlockedError, McpNetworkError } from '../errors.js';
import type { EgressLimits } from '../types.js';

/**
 * One HTTP exchange over `node:http(s)` with a caller-supplied DNS `lookup`
 * (so the SSRF guard validates the address actually dialled), connect/idle
 * deadlines and a response-size cap. Returns a WHATWG `Response` whose body
 * streams (SSE-safe). Redirects are NOT followed here.
 */
export interface NodeExchange {
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  signal: AbortSignal | null;
  lookup: net.LookupFunction;
  agent: http.Agent;
  limits: EgressLimits;
}

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'accept-encoding', 'content-length'];
const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function toNetworkError(err: unknown): unknown {
  // Errors raised by the guarded lookup (EgressBlockedError) and aborts pass through untouched.
  if (err instanceof McpNetworkError || err instanceof EgressBlockedError) return err;
  if (err instanceof Error && err.name === 'AbortError') return err;
  if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
    const reset = err.code === 'ECONNRESET' || err.code === 'EPIPE';
    return new McpNetworkError(reset ? 'reset' : 'connect_failed', err.code, { cause: err });
  }
  return err;
}

function responseHeaders(res: http.IncomingMessage): Headers {
  const headers = new Headers();
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i];
    const value = raw[i + 1];
    if (name === undefined || value === undefined) continue;
    try {
      headers.append(name, value);
    } catch {
      // Drop headers that are not valid per WHATWG (e.g. illegal bytes).
    }
  }
  return headers;
}

/** Wrap the Node response in a size-capped, backpressure-aware ReadableStream. */
function bodyStream(res: http.IncomingMessage, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  let done = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = (err: unknown) => {
        if (done) return;
        done = true;
        controller.error(err);
      };
      res.on('data', (chunk: Buffer) => {
        if (done) return;
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          fail(new McpNetworkError('response_too_large'));
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
        if ((controller.desiredSize ?? 1) <= 0) res.pause();
      });
      res.on('end', () => {
        if (done) return;
        done = true;
        controller.close();
      });
      res.on('error', (err) => fail(toNetworkError(err)));
      res.on('close', () => {
        if (!res.complete) fail(new McpNetworkError('reset'));
      });
    },
    pull() {
      res.resume();
    },
    cancel() {
      done = true;
      res.destroy();
    },
  }, { highWaterMark: 16 });
}

export function nodeExchange(url: URL, ex: NodeExchange): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    if (ex.signal?.aborted) {
      reject(abortReason(ex.signal));
      return;
    }
    const headers: Record<string, string> = {};
    ex.headers.forEach((value, name) => {
      if (!HOP_BY_HOP.includes(name)) headers[name] = value;
    });
    if (ex.body) headers['content-length'] = String(ex.body.byteLength);
    headers['user-agent'] ??= 'ocso-mcp/0.1';

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: ex.method,
      headers,
      agent: ex.agent,
      lookup: ex.lookup,
      timeout: ex.limits.idleTimeoutMs,
    });
    let settled = false;
    let connectTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      if (connectTimer) clearTimeout(connectTimer);
      ex.signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err: unknown) => {
      cleanup();
      if (settled) return;
      settled = true;
      reject(err);
    };
    const onAbort = () => {
      const reason = ex.signal ? abortReason(ex.signal) : new Error('aborted');
      req.destroy();
      fail(reason);
    };
    ex.signal?.addEventListener('abort', onAbort, { once: true });

    req.on('socket', (socket: net.Socket) => {
      if (!socket.connecting) return;
      connectTimer = setTimeout(() => req.destroy(new McpNetworkError('timeout', 'ECONNECT_TIMEOUT')), ex.limits.connectTimeoutMs);
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connectTimer));
    });
    req.on('timeout', () => req.destroy(new McpNetworkError('timeout', 'EIDLE_TIMEOUT')));
    req.on('error', (err) => fail(toNetworkError(err)));
    req.on('response', (res) => {
      if (connectTimer) clearTimeout(connectTimer);
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      const status = res.statusCode ?? 502;
      const nullBody = ex.method === 'HEAD' || NULL_BODY_STATUS.has(status);
      if (nullBody) res.resume();
      // Keep listening for abort while the body streams; detach once it ends.
      res.once('close', cleanup);
      try {
        resolve(
          new Response(nullBody ? null : bodyStream(res, ex.limits.maxResponseBytes), {
            status: status < 200 || status > 599 ? 502 : status,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders(res),
          }),
        );
      } catch (err) {
        res.destroy();
        reject(err);
      }
    });
    req.end(ex.body ?? undefined);
  });
}
