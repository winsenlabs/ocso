import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiBaseUrl, readSessionToken } from '@/lib/api/client';
import { isRealtimeEventType } from '@/lib/realtime/events';
import { SseParser, formatBlock } from '@/lib/realtime/sse';

/**
 * Same-origin SSE proxy for the staff realtime stream (ADR-020): the browser
 * never sees the API token. Forwards GET /v1/realtime/stream with the session
 * cookie as a Bearer token; the API filters events by conversation access.
 *   ?conversationId=<uuid>  only that conversation (filtered by the API)
 *   ?types=a,b,c            only these event types (filtered here)
 */
const Query = z.object({
  conversationId: z.uuid().optional(),
  types: z
    .string()
    .max(2_000)
    .optional()
    .transform((v) => (v ? v.split(',').filter(isRealtimeEventType) : [])),
});

/** Control events every subscriber needs: stream readiness and keepalives. */
const ALWAYS = new Set(['ready', 'ping']);

export async function GET(request: NextRequest): Promise<Response> {
  const token = await readSessionToken();
  if (!token) return error(401, 'authentication', 'unauthenticated', 'Sign in required');
  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return error(400, 'validation', 'invalid_query', 'Invalid realtime query');

  const upstreamUrl = new URL(`${apiBaseUrl()}/v1/realtime/stream`);
  if (parsed.data.conversationId) upstreamUrl.searchParams.set('conversationId', parsed.data.conversationId);
  // The API filters by type too, so narrow listeners (e.g. template review notices) stay cheap.
  if (parsed.data.types.length) upstreamUrl.searchParams.set('types', parsed.data.types.join(','));

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      cache: 'no-store',
      signal: request.signal,
    });
  } catch {
    return error(503, 'unreachable', 'api_unreachable', 'The OCSO API is not reachable.');
  }
  if (!upstream.ok || !upstream.body) {
    await upstream.body?.cancel();
    const category = upstream.status === 401 ? 'authentication' : upstream.status === 403 ? 'authorization' : 'internal';
    return error(upstream.status || 502, category, 'realtime_unavailable', 'The realtime stream is not available.');
  }

  const types = new Set(parsed.data.types);
  const body = types.size === 0 ? upstream.body : upstream.body.pipeThrough(filterTypes(types));
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      // no-transform keeps Next's compression from buffering the stream.
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    },
  });
}

function filterTypes(types: ReadonlySet<string>): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parser = new SseParser();
  return new TransformStream({
    transform(chunk, controller) {
      for (const message of parser.push(decoder.decode(chunk, { stream: true }))) {
        if (ALWAYS.has(message.event) || types.has(message.event)) controller.enqueue(encoder.encode(formatBlock(message)));
      }
    },
  });
}

function error(status: number, category: string, code: string, message: string): Response {
  return Response.json({ error: { category, code, message } }, { status });
}
